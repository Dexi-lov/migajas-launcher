mod auth;
mod diagnostics;
mod gist;
mod instances;
mod launch;
mod options;
mod screenshots;
mod server_ping;
mod sync;
mod mrpack;
mod types;
mod vault;

#[cfg(test)]
mod tests;

use launch::GameManager;
use sync::SyncManager;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

fn updater_error_message(context: &str, error: impl std::fmt::Display) -> String {
    let detail = error.to_string();
    let normalized = detail.to_ascii_lowercase();
    if normalized.contains("404")
        || normalized.contains("not found")
        || normalized.contains("no release")
    {
        "Todavía no hay una versión publicada para el actualizador. El propietario debe publicar una release de GitHub que incluya latest.json.".into()
    } else {
        format!("{context}: {detail}")
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Comandos stub para compatibilidad con el frontend (pendientes)
// ─────────────────────────────────────────────────────────────────────────

#[tauri::command]
async fn get_instances() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!([]))
}

#[tauri::command]
async fn check_instancia(id: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "valid": true, "id": id }))
}

#[tauri::command]
async fn borrar_instancia(id: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "deleted": true, "id": id }))
}

#[tauri::command]
fn open_discord_invite() -> Result<(), String> {
    open::that("https://discord.gg/eGxXWesV4J")
        .map_err(|error| format!("No se pudo abrir el Discord de Migajas: {error}"))
}

#[tauri::command]
async fn abrir_carpeta(_id: String) -> Result<(), String> {
    Err("Función no implementada aún".to_string())
}

#[tauri::command]
async fn export_instance(id: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "exported": true, "id": id }))
}

#[tauri::command]
async fn get_system_info() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "os": "Unknown",
        "arch": "x64",
        "totalMemory": 16384,
        "cores": 8
    }))
}

#[tauri::command]
async fn ping_servidor(ip: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ping": 50, "ip": ip }))
}

#[tauri::command]
async fn get_fabric_version(mc_version: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "version": "0.14.22", "mc": mc_version }))
}

#[tauri::command]
async fn get_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

#[tauri::command]
async fn get_mods() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!([]))
}

#[tauri::command]
async fn toggle_mod(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn updater_check(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let update = app
        .updater()
        .map_err(|error| format!("No se pudo iniciar el actualizador: {error}"))?
        .check()
        .await
        .map_err(|error| updater_error_message("No se pudo consultar actualizaciones", error))?;

    match update {
        Some(update) => Ok(serde_json::json!({
            "available": true,
            "currentVersion": update.current_version,
            "version": update.version,
            "notes": update.body.unwrap_or_default(),
        })),
        None => Ok(serde_json::json!({
            "available": false,
            "currentVersion": app.package_info().version.to_string(),
        })),
    }
}

#[tauri::command]
async fn updater_install(app: tauri::AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| format!("No se pudo iniciar el actualizador: {error}"))?
        .check()
        .await
        .map_err(|error| updater_error_message("No se pudo consultar la actualización", error))?
        .ok_or_else(|| "No hay una actualización disponible para instalar.".to_string())?;

    let app_for_progress = app.clone();
    let app_for_finish = app.clone();
    update
        .download_and_install(
            move |chunk_length, content_length| {
                let _ = app_for_progress.emit(
                    "updater-progress",
                    serde_json::json!({
                        "chunkLength": chunk_length,
                        "contentLength": content_length,
                    }),
                );
            },
            move || {
                let _ = app_for_finish.emit("updater-downloaded", ());
            },
        )
        .await
        .map_err(|error| format!("No se pudo instalar la actualización: {error}"))
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Native installers and HTTP/TLS require more stack than the Windows default.
    // Both async commands and spawn_blocking share this runtime's thread budget.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(8 * 1024 * 1024)
        .build()
        .expect("No se pudo iniciar el motor del launcher");
    tauri::async_runtime::set(runtime.handle().clone());
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SyncManager::default())
        .manage(GameManager::default())
        .manage(vault::VaultState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        // ── KILL-SWITCH: limpieza de mods al cerrar la app ─────────────
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();

                let app = window.app_handle().clone();
                let win = window.clone();

                tauri::async_runtime::spawn(async move {
                    // `try_state` debe invocarse dentro del bloque blocking
                    // para que `State<'_, _>` no cruce el límite 'static.
                    let app_for_cleanup = app.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        if let Some(state) = app_for_cleanup.try_state::<vault::VaultState>() {
                            state.cleanup_all();
                        }
                    })
                    .await;

                    let _ = win.destroy();
                    app.exit(0);
                });
            }
            tauri::WindowEvent::Destroyed if window.label() == "main" => {
                // Solo la ventana principal inicia el cierre y limpia el vault.
                if let Some(state) = window.app_handle().try_state::<vault::VaultState>() {
                    state.cleanup_all();
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            auth::auth_login_microsoft,
            auth::auth_restore_session,
            auth::auth_login_offline,
            auth::auth_logout,
            auth::auth_get_saved_profiles,
            sync::instance_sync,
            sync::instance_cancel_sync,
            launch::game_launch,
            launch::game_kill,
            options::get_game_options,
            options::save_game_options,
            options::list_resourcepacks,
            server_ping::server_ping,
            server_ping::get_server_status,
            diagnostics::analyze_crash,
            screenshots::get_screenshots,
            screenshots::get_screenshot_image,
            screenshots::open_screenshot_folder,
            screenshots::delete_screenshot,
            instances::check_instance_whitelist,
            instances::is_migajas_instance,
            instances::delete_instance,
            instances::list_local_instances,
            instances::delete_previous_instance,
            gist::gist_connect,
            gist::gist_editor_status,
            gist::gist_read_events,
            gist::gist_publish_events,
            gist::gist_disconnect,
            gist::gist_admin_code_status,
            gist::gist_set_admin_code,
            gist::gist_verify_admin_code,
            gist::gist_get_launcher_whitelist,
            gist::gist_publish_launcher_whitelist,
            get_instances,
            check_instancia,
            borrar_instancia,
            abrir_carpeta,
            export_instance,
            auth::auth_upload_skin,
            get_system_info,
            ping_servidor,
            get_fabric_version,
            get_version,
            get_mods,
            toggle_mod,
            open_discord_invite,
            updater_check,
            updater_install,
        ])
        .run(tauri::generate_context!())
        .expect("Error al ejecutar la aplicación Tauri");
}
