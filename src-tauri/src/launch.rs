use crate::types::*;
use crate::vault::{self, FileLock, VaultState};
use rayon::prelude::*;
use regex::Regex;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Mutex, watch};
use tokio::task;

/// Estado para rastrear procesos Java activos por instancia.
#[derive(Default)]
pub struct GameManager {
    pub processes: Arc<Mutex<HashMap<String, u32>>>, // instanceId -> PID
    pub cancel_tokens: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
}

/// Comando: game_launch
#[tauri::command]
pub async fn game_launch(
    app: AppHandle,
    state: tauri::State<'_, GameManager>,
    vault_state: tauri::State<'_, VaultState>,
    config: LaunchConfig,
) -> Result<serde_json::Value, String> {
    // Validación de instancia
    if config.instance_id.is_empty() || config.instance_id.len() > 64 {
        return Ok(serde_json::json!({
            "started": false,
            "error": "instanceId inválido"
        }));
    }

    let whitelist = crate::instances::check_saved_profile_whitelist(
        &app,
        &config.instance_id,
        &config.profile_uuid,
    )
    .await?;
    if !whitelist.allowed {
        return Ok(serde_json::json!({
            "started": false,
            "error": whitelist.reason
        }));
    }

    let sanitized_args: Vec<String> = config
        .custom_jvm_args
        .into_iter()
        .filter(|arg| {
            !arg.contains(";") && !arg.contains("|") && !arg.contains("&") && !arg.contains("$(")
        })
        .collect();

    let instance_root = crate::options::instance_dir(&app, &config.instance_id)?;
    crate::sync::activate_pack_mods_if_all_disabled(&instance_root)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No se pudo resolver la carpeta de datos: {e}"))?;
    let game_version = config.version_mc.clone().unwrap_or_else(|| "1.21.1".into());
    let loader = config
        .tipo_loader
        .clone()
        .unwrap_or_else(|| "neoforge".into());

    let auth =
        crate::auth::auth_restore_session(app.clone(), Some(config.profile_uuid.clone())).await?;
    if !auth.success {
        return Err(auth
            .error
            .map(|e| e.message)
            .unwrap_or_else(|| "No se pudo restaurar la sesión de Minecraft.".into()));
    }
    let profile = auth
        .profile
        .ok_or_else(|| "La sesión no contiene un perfil de Minecraft.".to_string())?;
    let can_view_instances =
        crate::gist::launcher_user_can_view_instances(&profile.uuid, &profile.username).await?;
    if !can_view_instances {
        return Ok(serde_json::json!({
            "started": false,
            "error": "Tu cuenta no está autorizada para acceder a las instancias del launcher."
        }));
    }
    let account = match profile.account_type {
        AccountType::Microsoft => mc_launcher_core::account::Account::Microsoft {
            username: profile.username,
            uuid: profile.uuid,
            access_token: profile.access_token.ok_or_else(|| {
                "La sesión de Microsoft no tiene un token de Minecraft válido.".to_string()
            })?,
        },
        AccountType::Offline => mc_launcher_core::account::Account::Offline {
            username: profile.username,
            uuid: profile.uuid,
        },
    };

    let launch_app_data = app_data.clone();
    let launch_instance_root = instance_root.clone();
    let launch_app = app.clone();
    let launch_game_version = game_version.clone();
    let launch_loader = loader.clone();
    let launch_url = config.url_loader.clone();
    let launch_loader_version = config.loader_version.clone();
    let launch_java_version = config.java_version.clone().unwrap_or_else(|| "21".into());
    let launch_resolution = config
        .resolution
        .as_ref()
        .filter(|r| r.width > 0 && r.height > 0)
        .map(|r| (r.width, r.height));
    let launch_memory_min = config.memory_mb.min.max(512);
    let launch_memory_max = config.memory_mb.max.max(1024);
    let launch_custom_args = sanitized_args;
    let launch_account = account;
    let prepared = task::spawn_blocking(move || {
        prepare_game_launch(
            launch_app,
            &launch_app_data,
            &launch_instance_root,
            &launch_game_version,
            &launch_loader,
            launch_url.as_deref(),
            launch_loader_version.as_deref(),
            &launch_java_version,
            launch_account,
            launch_resolution,
            launch_memory_min,
            launch_memory_max,
            launch_custom_args,
        )
    })
    .await
    .map_err(|e| format!("Falló la preparación del juego: {e}"))??;

    // ── VAULT: descifrado JIT de los mods ─────────────────────────────
    let vault_dir = instance_root.join(".vault");
    let mods_dir = instance_root.join("mods");

    let locks: Vec<FileLock> = if vault_dir.exists() {
        vault::materialize_mods(&config.instance_id, &vault_dir, &mods_dir)
            .map_err(|e| format!("materializar mods: {e}"))?
    } else {
        Vec::new()
    };

    // Registrar para el kill-switch global
    vault_state.mark_active(
        &config.instance_id,
        vault_dir.clone(),
        mods_dir.clone(),
    );

    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    state
        .cancel_tokens
        .lock()
        .await
        .insert(config.instance_id.clone(), cancel_tx.clone());

    let mut cmd = Command::new(&prepared.executable);
    cmd.args(&prepared.args)
        .current_dir(&prepared.working_dir)
        .envs(prepared.env.iter().map(|(key, value)| (key, value)))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    // Log args redactados para el frontend
    let redacted_args = vault::redact_jvm_args(&prepared.args);
    let _ = app.emit(
        "game://log-batch",
        GameLogBatchEvent {
            instance_id: config.instance_id.clone(),
            lines: vec![GameLogLine {
                timestamp: chrono_like_timestamp(),
                level: LogLevel::Info,
                text: format!("JVM args: {}", redacted_args.join(" ")),
            }],
        },
    );

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            // Si falló el spawn, liberar locks y limpiar mods
            drop(locks);
            let _ = vault::cleanup_materialized_mods(&vault_dir, &mods_dir);
            if let Some(vs) = app.try_state::<VaultState>() {
                vs.clear_active(&config.instance_id);
            }
            return Ok(serde_json::json!({
                "started": false,
                "error": format!("No se pudo iniciar Minecraft: {e}")
            }));
        }
    };

    let pid = child.id().unwrap_or(0);
    state
        .processes
        .lock()
        .await
        .insert(config.instance_id.clone(), pid);

    emit_state(&app, &config.instance_id, GameState::StartingJvm, Some(pid));
    emit_state(&app, &config.instance_id, GameState::Running, Some(pid));

    // Capturar stdout y stderr
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let log_directory = instance_root.join("logs");
    let _ = std::fs::create_dir_all(&log_directory);
    let launch_log = Arc::new(StdMutex::new(std::fs::File::create(log_directory.join("migajas-launch.log")).ok()));

    let app_out = app.clone();
    let iid_out = config.instance_id.clone();
    let stdout_log = launch_log.clone();
    let stdout_task = task::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut batch = Vec::new();
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(150));
        loop {
            tokio::select! {
                line = reader.next_line() => {
                    match line {
                        Ok(Some(text)) => {
                            append_launch_log(&stdout_log, &text);
                            batch.push(GameLogLine {
                                timestamp: chrono_like_timestamp(),
                                level: LogLevel::Info,
                                text: redact_tokens(&text),
                            });
                        }
                        _ => break,
                    }
                }
                _ = interval.tick() => {
                    if !batch.is_empty() {
                        let _ = app_out.emit("game://log-batch", GameLogBatchEvent {
                            instance_id: iid_out.clone(),
                            lines: std::mem::take(&mut batch),
                        });
                    }
                }
            }
        }
        if !batch.is_empty() {
            let _ = app_out.emit(
                "game://log-batch",
                GameLogBatchEvent {
                    instance_id: iid_out.clone(),
                    lines: batch,
                },
            );
        }
    });

    let app_err = app.clone();
    let iid_err = config.instance_id.clone();
    let stderr_log = launch_log.clone();
    let stderr_task = task::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut batch = Vec::new();
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(150));
        loop {
            tokio::select! {
                line = reader.next_line() => {
                    match line {
                        Ok(Some(text)) => {
                            append_launch_log(&stderr_log, &text);
                            batch.push(GameLogLine {
                                timestamp: chrono_like_timestamp(),
                                level: LogLevel::Error,
                                text: redact_tokens(&text),
                            });
                        }
                        _ => break,
                    }
                }
                _ = interval.tick() => {
                    if !batch.is_empty() {
                        let _ = app_err.emit("game://log-batch", GameLogBatchEvent {
                            instance_id: iid_err.clone(),
                            lines: std::mem::take(&mut batch),
                        });
                    }
                }
            }
        }
        if !batch.is_empty() {
            let _ = app_err.emit(
                "game://log-batch",
                GameLogBatchEvent {
                    instance_id: iid_err.clone(),
                    lines: batch,
                },
            );
        }
    });

    // Monitor del proceso + kill-switch: los locks viven hasta que Java muere
    let app_mon = app.clone();
    let iid_mon = config.instance_id.clone();
    let mods_dir_mon = mods_dir.clone();
    let vault_dir_mon = vault_dir.clone();
    let processes = state.processes.clone();
    let cancel_tokens = state.cancel_tokens.clone();

    let monitor = task::spawn(async move {
        loop {
            tokio::select! {
                status = child.wait() => {
                    match status {
                        Ok(exit) => {
                            let code = exit.code().unwrap_or(-1);
                            if code == 0 {
                                emit_state(&app_mon, &iid_mon, GameState::Stopped, None);
                            } else {
                                emit_state(&app_mon, &iid_mon, GameState::Crashed, None);
                                let diag = diagnose_crash(code, "instances/crash-reports");
                                let _ = app_mon.emit("game://crashed", diag);
                            }
                        }
                        Err(_) => {
                            emit_state(&app_mon, &iid_mon, GameState::Crashed, None);
                        }
                    }
                    break;
                }
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        let _ = child.kill().await;
                        emit_state(&app_mon, &iid_mon, GameState::Stopped, None);
                        break;
                    }
                }
            }
        }

        // ── KILL-SWITCH: liberar locks y borrar mods en claro ─────────
        drop(locks);
        let _ = vault::cleanup_materialized_mods(&vault_dir_mon, &mods_dir_mon);
        if let Some(vs) = app_mon.try_state::<VaultState>() {
            vs.clear_active(&iid_mon);
        }

        // Limpiar estado interno
        processes.lock().await.remove(&iid_mon);
        cancel_tokens.lock().await.remove(&iid_mon);
    });

    let _ = monitor;
    let _ = stdout_task;
    let _ = stderr_task;


    Ok(serde_json::json!({
        "started": true,
        "pid": pid,
        "error": null
    }))
}

fn prepare_game_launch(
    app: AppHandle,
    app_data: &Path,
    instance_dir: &Path,
    minecraft_version: &str,
    loader_name: &str,
    loader_url: Option<&str>,
    loader_version: Option<&str>,
    java_version: &str,
    account: mc_launcher_core::account::Account,
    resolution: Option<(u32, u32)>,
    min_memory: u32,
    max_memory: u32,
    custom_args: Vec<String>,
) -> Result<mc_launcher_core::prelude::LaunchCommand, String> {
    use mc_launcher_core::prelude::{
        InstallRequest, JavaInstallPolicy, LaunchOptions, Launcher, LoaderSpec, LoaderVersion,
    };

    let minecraft_dir = app_data.join("minecraft");
    std::fs::create_dir_all(&minecraft_dir)
        .map_err(|e| format!("No se pudo crear el directorio de Minecraft: {e}"))?;
    emit_install_status(
        &app,
        &instance_id_from_path(instance_dir),
        &format!("Preparando Java {java_version}..."),
    );
    let java = ensure_java_runtime(app_data, java_version)?;
    let launcher = Launcher::new(&minecraft_dir);
    let event_instance_id = instance_id_from_path(instance_dir);
    let mut last_progress = std::time::Instant::now();
    let mut reporter = |event: mc_launcher_core::progress::ProgressEvent| {
        use mc_launcher_core::progress::ProgressEvent;
        match event {
            ProgressEvent::TaskStarted { label, .. } => {
                emit_install_status(&app, &event_instance_id, &format!("Descargando {label}..."));
                last_progress = std::time::Instant::now();
            }
            ProgressEvent::BytesReceived { label, .. }
                if last_progress.elapsed() >= std::time::Duration::from_millis(350) =>
            {
                emit_install_status(&app, &event_instance_id, &format!("Descargando {label}..."));
                last_progress = std::time::Instant::now();
            }
            ProgressEvent::TaskFinished { label } => {
                emit_install_status(&app, &event_instance_id, &format!("Instalando {label}..."));
                last_progress = std::time::Instant::now();
            }
            _ => {}
        }
    };

    parallel_prefetch_minecraft_files(&app, &event_instance_id, minecraft_version, &minecraft_dir)?;

    let loader_lower = loader_name.to_ascii_lowercase();
    let mut version_id = minecraft_version.to_string();
    if loader_lower.contains("neo") || loader_lower.contains("forge") {
        launcher
            .install_with_progress(InstallRequest::vanilla(minecraft_version), &mut reporter)
            .map_err(|e| format!("No se pudo instalar Minecraft {minecraft_version}: {e}"))?;
        emit_install_status(&app, &event_instance_id, "Instalando NeoForge...");
        let (resolved_loader_version, url) = resolve_forge_installer(&loader_lower, loader_url, loader_version)?;
        let installer_dir = app_data.join("installers");
        std::fs::create_dir_all(&installer_dir)
            .map_err(|e| format!("No se pudo preparar el instalador: {e}"))?;
        let installer_path = installer_dir.join(format!(
            "{}-{}.jar",
            if loader_lower.contains("neo") {
                "neoforge"
            } else {
                "forge"
            },
            safe_component(&resolved_loader_version)
        ));
        if installer_path.exists() && !is_valid_loader_installer(&installer_path) {
            std::fs::remove_file(&installer_path)
                .map_err(|e| format!("No se pudo reemplazar un instalador inválido: {e}"))?;
        }
        if !installer_path.exists() {
            let response = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(600))
                .build()
                .map_err(|e| format!("No se pudo preparar la descarga del loader: {e}"))?
                .get(url)
                .send()
                .map_err(|e| format!("No se pudo descargar el instalador del loader: {e}"))?
                .error_for_status()
                .map_err(|e| format!("El servidor rechazó el instalador del loader: {e}"))?;
            let bytes = response
                .bytes()
                .map_err(|e| format!("Descarga incompleta del instalador: {e}"))?;
            if bytes.len() < 1024 {
                return Err("El instalador descargado está vacío o no es válido.".into());
            }
            std::fs::write(&installer_path, &bytes)
                .map_err(|e| format!("No se pudo guardar el instalador: {e}"))?;
            if !is_valid_loader_installer(&installer_path) {
                let _ = std::fs::remove_file(&installer_path);
                return Err("El enlace del loader no devolvió un instalador Java válido. Para Forge/NeoForge, configura la URL del instalador JAR o los metadatos oficiales de Prism Launcher.".into());
            }
        }
        let kind = if loader_lower.contains("neo") {
            mc_launcher_core::loader::LoaderKind::NeoForge
        } else {
            mc_launcher_core::loader::LoaderKind::Forge
        };
        ensure_launcher_profiles(&minecraft_dir)?;
        run_loader_installer_hidden(&mc_launcher_core::install::loader::InstallerInvocation {
            loader: kind,
            java_executable: java.clone(),
            installer_path,
            minecraft_dir: minecraft_dir.clone(),
        })?;
        version_id = if loader_lower.contains("neo") {
            mc_launcher_core::loader::neoforge::neoforge_installed_version_id(
                minecraft_version,
                &resolved_loader_version,
            )
        } else {
            mc_launcher_core::loader::forge::forge_installed_version_id(&resolved_loader_version)
                .map_err(|e| format!("No se pudo resolver el perfil de Forge: {e}"))?
        };
        launcher.load_version(&version_id).map_err(|e| {
            format!("El instalador terminó pero no creó el perfil {version_id}: {e}")
        })?;
    } else {
        let loader_spec = if loader_lower.contains("fabric") {
            let requested_version = loader_version
                .map(str::to_owned)
                .or_else(|| loader_version_from_fabric_url(loader_url, minecraft_version));
            let compatible_version = resolve_fabric_loader_version(
                &app,
                &event_instance_id,
                minecraft_version,
                requested_version.as_deref(),
            )?;
            Some(LoaderSpec::Fabric {
                version: LoaderVersion::Exact(compatible_version),
            })
        } else if loader_lower.contains("quilt") {
            Some(LoaderSpec::Quilt {
                version: loader_version
                    .map(|v| LoaderVersion::Exact(v.to_string()))
                    .unwrap_or(LoaderVersion::LatestStable),
            })
        } else {
            None
        };
        if let Some(loader_spec) = loader_spec {
            version_id = launcher
                .install_with_progress(
                    InstallRequest {
                        minecraft_version: minecraft_version.to_string(),
                        loader: Some(loader_spec),
                        java: JavaInstallPolicy::Never,
                    },
                    &mut reporter,
                )
                .map_err(|e| format!("No se pudo instalar el mod loader: {e}"))?
                .version_id;
        } else {
            launcher
                .install_with_progress(InstallRequest::vanilla(minecraft_version), &mut reporter)
                .map_err(|e| format!("No se pudo instalar Minecraft {minecraft_version}: {e}"))?;
        }
    }

    emit_install_status(
        &app,
        &event_instance_id,
        "Preparando el inicio de Minecraft...",
    );
    let version = launcher
        .load_version(&version_id)
        .map_err(|e| format!("No se encontró la instalación {version_id}: {e}"))?;
    let natives_directory = prepare_native_libraries(&minecraft_dir, &version)?;
    let mut command = launcher
        .build_launch_command_from_version(
            &version,
            LaunchOptions {
                account,
                java_executable: Some(java),
                natives_directory: Some(natives_directory),
                game_directory: Some(instance_dir.to_path_buf()),
                custom_resolution: resolution,
                ..Default::default()
            },
        )
        .map_err(|e| format!("No se pudo preparar el inicio del juego: {e}"))?;
    command.args.splice(
        0..0,
        [
            format!("-Xms{}M", min_memory),
            format!("-Xmx{}M", max_memory),
        ],
    );
    let insert_at = command
        .args
        .iter()
        .position(|arg| arg == "-cp" || arg == "-classpath")
        .unwrap_or(2);
    command.args.splice(insert_at..insert_at, custom_args);
    Ok(command)
}

fn prepare_native_libraries(minecraft_dir: &Path, version: &mc_launcher_core::core::version::VersionJson) -> Result<PathBuf, String> {
    let id = version.id.as_deref().ok_or("El perfil de Minecraft no tiene identificador.")?;
    // Forge profiles inherit native JARs, but need extraction under their own id.
    mc_launcher_core::install::natives::extract_natives(&version.libraries, minecraft_dir, id)
        .map_err(|error| format!("No se pudieron preparar las bibliotecas nativas de Minecraft: {error}"))
}

fn resolve_forge_installer(loader: &str, url: Option<&str>, version: Option<&str>) -> Result<(String, String), String> {
    let url = url.map(str::trim).filter(|value| !value.is_empty());
    let version = version.map(str::trim).filter(|value| !value.is_empty())
        .map(str::to_owned).or_else(|| url.and_then(loader_version_from_url))
        .ok_or_else(|| "El evento necesita la versión de Forge/NeoForge o un enlace de instalador que la identifique.".to_string())?;
    if !is_safe_loader_version(&version) {
        return Err("La versión configurada del mod loader no es válida.".into());
    }
    let download = match url {
        Some(value) if value.to_ascii_lowercase().ends_with(".jar") => value.to_owned(),
        _ if loader.contains("neo") => mc_launcher_core::loader::neoforge::installer_url(&version),
        _ => mc_launcher_core::loader::forge::installer_url(&version),
    };
    if !download.starts_with("https://") {
        return Err("La URL del instalador debe usar HTTPS.".into());
    }
    Ok((version, download))
}

fn ensure_launcher_profiles(minecraft_dir: &Path) -> Result<(), String> {
    let profile_path = minecraft_dir.join("launcher_profiles.json");
    if profile_path.exists() {
        return Ok(());
    }
    let profiles = serde_json::json!({ "profiles": {}, "settings": {} });
    let bytes = serde_json::to_vec_pretty(&profiles)
        .map_err(|e| format!("No se pudo preparar el perfil local de Minecraft: {e}"))?;
    std::fs::write(&profile_path, bytes)
        .map_err(|e| format!("No se pudo crear launcher_profiles.json: {e}"))
}

fn instance_id_from_path(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string()
}

fn emit_install_status(app: &AppHandle, instance_id: &str, status: &str) {
    let _ = app.emit(
        "game://install-progress",
        serde_json::json!({
            "instanceId": instance_id,
            "status": status,
        }),
    );
}

fn loader_version_from_fabric_url(url: Option<&str>, minecraft_version: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url?).ok()?;
    if parsed.scheme() != "https" || parsed.host_str()? != "meta.fabricmc.net" {
        return None;
    }
    let segments: Vec<_> = parsed.path_segments()?.collect();
    if segments.len() == 7
        && segments[0] == "v2"
        && segments[1] == "versions"
        && segments[2] == "loader"
        && segments[3] == minecraft_version
        && segments[5] == "profile"
        && segments[6] == "json"
    {
        Some(segments[4].to_owned())
    } else {
        None
    }
}

fn resolve_fabric_loader_version(
    app: &AppHandle,
    instance_id: &str,
    minecraft_version: &str,
    requested_version: Option<&str>,
) -> Result<String, String> {
    emit_install_status(
        app,
        instance_id,
        "Buscando versiones de Fabric compatibles...",
    );
    let url = format!("https://meta.fabricmc.net/v2/versions/loader/{minecraft_version}");
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| format!("No se pudo preparar la consulta a Fabric Meta: {error}"))?;
    let response = client
        .get(&url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|error| {
            format!(
                "Fabric Meta no devolvió versiones compatibles con Minecraft {minecraft_version}: {error}"
            )
        })?;
    let versions: Vec<mc_launcher_core::loader::fabric::FabricLoaderVersion> = response
        .json()
        .map_err(|error| format!("Fabric Meta devolvió datos no válidos: {error}"))?;
    if versions.is_empty() {
        return Err(format!(
            "No hay versiones de Fabric disponibles para Minecraft {minecraft_version}."
        ));
    }

    if let Some(requested) = requested_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(compatible) = versions.iter().find(|version| version.version == requested) {
            return Ok(compatible.version.clone());
        }
    }
    versions
        .iter()
        .find(|version| version.stable)
        .or_else(|| versions.first())
        .map(|version| version.version.clone())
        .ok_or_else(|| {
            format!("No se pudo elegir una versión de Fabric para Minecraft {minecraft_version}.")
        })
}

fn parallel_prefetch_minecraft_files(
    app: &AppHandle,
    instance_id: &str,
    minecraft_version: &str,
    minecraft_dir: &Path,
) -> Result<(), String> {
    emit_install_status(app, instance_id, "Preparando archivos de Minecraft...");
    let version = mc_launcher_core::install::client::fetch_vanilla_version(minecraft_version)
        .map_err(|error| format!("No se pudieron consultar los archivos de Minecraft: {error}"))?;
    let plan = mc_launcher_core::install::vanilla::plan_vanilla_downloads(&version, minecraft_dir)
        .map_err(|error| format!("No se pudo preparar la descarga de Minecraft: {error}"))?;
    download_minecraft_plan(app, instance_id, &plan.tasks)?;

    if let Some(asset_index) = version.asset_index.as_ref() {
        let index_path =
            mc_launcher_core::install::assets::asset_index_path(minecraft_dir, &asset_index.id);
        let bytes = std::fs::read(&index_path).map_err(|error| {
            format!("No se pudo leer el índice de recursos de Minecraft: {error}")
        })?;
        let index: mc_launcher_core::install::assets::AssetIndexJson =
            serde_json::from_slice(&bytes).map_err(|error| {
                format!("El índice de recursos de Minecraft no es válido: {error}")
            })?;
        let object_plan = mc_launcher_core::install::assets::plan_asset_object_downloads_from_index(
            &index,
            minecraft_dir,
        );
        download_minecraft_plan(app, instance_id, &object_plan.tasks)?;
    }

    Ok(())
}

fn download_minecraft_plan(
    app: &AppHandle,
    instance_id: &str,
    tasks: &[mc_launcher_core::net::download::DownloadTask],
) -> Result<(), String> {
    let mut pending = Vec::new();
    for task in tasks {
        let already_installed = mc_launcher_core::net::download::should_skip_existing(task)
            .map_err(|error| format!("No se pudo verificar {}: {error}", task.label))?;
        if !already_installed {
            pending.push(task.clone());
        }
    }
    if pending.is_empty() {
        return Ok(());
    }

    let client = reqwest::blocking::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(900))
        .pool_max_idle_per_host(12)
        .build()
        .map_err(|error| format!("No se pudo preparar la descarga de Minecraft: {error}"))?;
    let workers = std::thread::available_parallelism()
        .map(|count| count.get().clamp(4, 12))
        .unwrap_or(8);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(workers)
        .stack_size(8 * 1024 * 1024)
        .build()
        .map_err(|error| format!("No se pudo iniciar la descarga paralela: {error}"))?;
    let total = pending.len();
    let completed = AtomicUsize::new(0);
    let received = AtomicU64::new(0);
    let last_status = StdMutex::new(std::time::Instant::now());
    emit_install_status(
        app,
        instance_id,
        &format!("Descargando archivos de Minecraft (0/{total})..."),
    );

    pool.install(|| {
        pending.par_iter().try_for_each(|task| {
            download_minecraft_task(&client, task, |chunk_bytes| {
                received.fetch_add(chunk_bytes, Ordering::Relaxed);
                let mut last = match last_status.lock() {
                    Ok(last) => last,
                    Err(_) => return,
                };
                if last.elapsed() >= std::time::Duration::from_millis(400) {
                    let done = completed.load(Ordering::Relaxed);
                    let mib = received.load(Ordering::Relaxed) / (1024 * 1024);
                    emit_install_status(
                        app,
                        instance_id,
                        &format!("Descargando Minecraft: {done}/{total} archivos ({mib} MB)..."),
                    );
                    *last = std::time::Instant::now();
                }
            })?;
            let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
            let mut last = last_status
                .lock()
                .map_err(|_| "No se pudo actualizar el progreso de Minecraft.".to_string())?;
            if done == total || last.elapsed() >= std::time::Duration::from_millis(400) {
                let mib = received.load(Ordering::Relaxed) / (1024 * 1024);
                emit_install_status(
                    app,
                    instance_id,
                    &format!("Descargando Minecraft: {done}/{total} archivos ({mib} MB)..."),
                );
                *last = std::time::Instant::now();
            }
            Ok::<(), String>(())
        })
    })
}

fn download_minecraft_task(
    client: &reqwest::blocking::Client,
    task: &mc_launcher_core::net::download::DownloadTask,
    mut on_bytes: impl FnMut(u64),
) -> Result<(), String> {
    let parent = task
        .destination
        .parent()
        .ok_or_else(|| format!("No se pudo preparar el destino de {}.", task.label))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("No se pudo crear la carpeta de {}: {error}", task.label))?;
    let temporary = parent.join(format!(
        ".migajas-download-{}.part",
        uuid::Uuid::new_v4().simple()
    ));
    let mut last_error = String::new();

    for attempt in 0..3 {
        let result = (|| {
            let mut response = client
                .get(&task.url)
                .send()
                .and_then(reqwest::blocking::Response::error_for_status)
                .map_err(|error| format!("Descarga fallida para {}: {error}", task.label))?;
            let mut output = std::fs::File::create(&temporary)
                .map_err(|error| format!("No se pudo guardar {}: {error}", task.label))?;
            let mut buffer = vec![0u8; 128 * 1024];
            loop {
                let count = response.read(&mut buffer).map_err(|error| {
                    format!("Descarga interrumpida para {}: {error}", task.label)
                })?;
                if count == 0 {
                    break;
                }
                output
                    .write_all(&buffer[..count])
                    .map_err(|error| format!("No se pudo escribir {}: {error}", task.label))?;
                on_bytes(count as u64);
            }
            output
                .flush()
                .map_err(|error| format!("No se pudo finalizar {}: {error}", task.label))?;
            verify_minecraft_download(&temporary, task)?;
            if task.destination.exists() {
                std::fs::remove_file(&task.destination)
                    .map_err(|error| format!("No se pudo reemplazar {}: {error}", task.label))?;
            }
            std::fs::rename(&temporary, &task.destination)
                .map_err(|error| format!("No se pudo instalar {}: {error}", task.label))?;
            Ok::<(), String>(())
        })();

        match result {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = error;
                let _ = std::fs::remove_file(&temporary);
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(300 * (attempt + 1)));
                }
            }
        }
    }

    Err(last_error)
}

#[cfg(test)]
mod download_regression_tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn forge_inheritance_extracts_natives_into_the_launched_profile() {
        let root = tempfile::tempdir().unwrap();
        let repository_path = "org/lwjgl/lwjgl/3.2.2/lwjgl-3.2.2-natives-windows.jar";
        let jar = root.path().join("libraries").join(repository_path);
        std::fs::create_dir_all(jar.parent().unwrap()).unwrap();
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&jar).unwrap());
        zip.start_file("lwjgl.dll", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(b"test native library").unwrap();
        zip.finish().unwrap();
        let parent = serde_json::json!({"id":"1.18.2","libraries":[{
            "name":"org.lwjgl:lwjgl:3.2.2","natives":{"windows":"natives-windows"},
            "downloads":{"classifiers":{"natives-windows":{"path":repository_path,
                "url":"https://example.invalid/native.jar","sha1":"test","size":0}}}
        }]});
        let child = serde_json::json!({"id":"1.18.2-forge-test","inheritsFrom":"1.18.2"});
        for (id, metadata) in [("1.18.2", parent), ("1.18.2-forge-test", child)] {
            let folder = root.path().join("versions").join(id);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join(format!("{id}.json")), metadata.to_string()).unwrap();
        }
        let launcher = mc_launcher_core::prelude::Launcher::new(root.path());
        let resolved = launcher.load_version("1.18.2-forge-test").unwrap();
        let natives = prepare_native_libraries(root.path(), &resolved).unwrap();
        assert_eq!(natives, root.path().join("versions/1.18.2-forge-test/natives"));
        assert_eq!(std::fs::read(natives.join("lwjgl.dll")).unwrap(), b"test native library");
    }

    #[test]
    fn launch_log_keeps_errors_without_authentication_tokens() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("launch.log");
        let writer = StdMutex::new(Some(std::fs::File::create(&path).unwrap()));
        append_launch_log(&writer, "Exception in thread main --accessToken opaque-test-secret, eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.fakeSignature");
        let text = std::fs::read_to_string(path).unwrap();
        assert!(text.contains("Exception in thread main"));
        assert!(!text.contains("opaque-test-secret"));
        assert!(!text.contains("fakeSignature"));
    }

    #[test]
    fn archived_neoforge_event_needs_only_its_version() {
        let (version, url) = resolve_forge_installer("neoforge", None, Some("21.1.265")).unwrap();
        assert_eq!(version, "21.1.265");
        assert_eq!(url, "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.265/neoforge-21.1.265-installer.jar");
        assert!(resolve_forge_installer("neoforge", None, None).is_err());
        assert!(resolve_forge_installer("neoforge", None, Some("../../bad")).is_err());
    }

    #[test]
    fn parallel_downloads_are_verified_and_reusable() {
        use mc_launcher_core::net::download::{Checksum, DownloadTask, should_skip_existing};
        use sha2::{Digest, Sha256};
        let directory = tempfile::tempdir().unwrap();
        let body = vec![42u8; 192 * 1024];
        let checksum = format!("{:x}", Sha256::digest(&body));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..32 {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
                let mut request = [0u8; 2048];
                socket.read(&mut request).unwrap();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                socket.write_all(&body).unwrap();
            }
        });
        let client = reqwest::blocking::Client::builder().no_proxy()
            .timeout(std::time::Duration::from_secs(20)).build().unwrap();
        let tasks: Vec<_> = (0..32).map(|index| DownloadTask {
            url: format!("http://{address}/{index}"), destination: directory.path().join(format!("{index}.jar")),
            checksum: Some(Checksum::Sha256(checksum.clone())), label: format!("archivo {index}"),
        }).collect();
        let pool = rayon::ThreadPoolBuilder::new().num_threads(4).stack_size(8 * 1024 * 1024).build().unwrap();
        pool.install(|| tasks.par_iter().try_for_each(|task| download_minecraft_task(&client, task, |_| {}))).unwrap();
        server.join().unwrap();
        for task in &tasks {
            verify_minecraft_download(&task.destination, task).unwrap();
            let mut sha1_task = task.clone();
            sha1_task.checksum = Some(Checksum::Sha1(mc_launcher_core::io::hash::sha1_file(&task.destination).unwrap()));
            assert!(should_skip_existing(&sha1_task).unwrap());
        }
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(),32);
    }
}

fn verify_minecraft_download(
    path: &Path,
    task: &mc_launcher_core::net::download::DownloadTask,
) -> Result<(), String> {
    use mc_launcher_core::net::download::Checksum;
    let expected = match task.checksum.as_ref() {
        Some(Checksum::Sha1(_)) => mc_launcher_core::io::hash::sha1_file(path)
            .map_err(|error| format!("No se pudo verificar {}: {error}", task.label))?,
        Some(Checksum::Sha256(_)) => {
            use sha2::Digest;
            let mut file = std::fs::File::open(path)
                .map_err(|error| format!("No se pudo verificar {}: {error}", task.label))?;
            let mut hasher = sha2::Sha256::new();
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                let count = file
                    .read(&mut buffer)
                    .map_err(|error| format!("No se pudo verificar {}: {error}", task.label))?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
            }
            format!("{:x}", hasher.finalize())
        }
        None => return Ok(()),
    };
    let expected_hash = match task.checksum.as_ref().unwrap() {
        Checksum::Sha1(value) | Checksum::Sha256(value) => value,
    };
    if !expected.eq_ignore_ascii_case(expected_hash) {
        return Err(format!(
            "La verificación SHA no coincide para {}.",
            task.label
        ));
    }
    Ok(())
}

fn run_loader_installer_hidden(
    invocation: &mc_launcher_core::install::loader::InstallerInvocation,
) -> Result<(), String> {
    let mut command = std::process::Command::new(&invocation.java_executable);
    command
        .args(mc_launcher_core::install::loader::installer_command_args(
            invocation,
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .map_err(|error| format!("No se pudo iniciar el instalador del loader: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let details = String::from_utf8_lossy(&output.stderr);
    let details = details.trim();
    if details.is_empty() {
        Err(format!(
            "El instalador del loader terminó con código {:?}.",
            output.status.code()
        ))
    } else {
        Err(format!(
            "El instalador del loader terminó con código {:?}: {}",
            output.status.code(),
            details
                .chars()
                .rev()
                .take(1200)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ))
    }
}

fn safe_component(value: &str) -> String {
    let safe: String = value
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
        .collect();
    if safe.is_empty() {
        "latest".into()
    } else {
        safe
    }
}

fn loader_version_from_url(url: &str) -> Option<String> {
    if let Ok(parsed) = reqwest::Url::parse(url) {
        if parsed.host_str() == Some("meta.prismlauncher.org") {
            let file_name = parsed.path_segments()?.last()?;
            return file_name.strip_suffix(".json").map(str::to_owned);
        }
    }
    let parts: Vec<&str> = url.split('/').collect();
    parts.iter().enumerate().find_map(|(i, part)| {
        if *part == "neoforge" || *part == "forge" {
            parts.get(i + 1).map(|v| (*v).to_string())
        } else {
            None
        }
    })
}

fn is_safe_loader_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 80
        && version
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
}

fn is_valid_loader_installer(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return false;
    };
    archive.by_name("META-INF/MANIFEST.MF").is_ok()
}

fn ensure_java_runtime(app_data: &Path, major: &str) -> Result<PathBuf, String> {
    #[cfg(windows)]
    let executable_name = "java.exe";
    #[cfg(not(windows))]
    let executable_name = "java";
    let runtime_root = app_data.join("runtime").join(format!("java-{major}"));
    if let Some(path) = find_file(&runtime_root, executable_name) {
        return Ok(path);
    }

    #[cfg(windows)]
    let download_url = format!(
        "https://api.adoptium.net/v3/binary/latest/{major}/ga/windows/x64/jre/hotspot/normal/eclipse"
    );
    #[cfg(target_os = "linux")]
    let download_url = format!(
        "https://api.adoptium.net/v3/binary/latest/{major}/ga/linux/x64/jre/hotspot/normal/eclipse"
    );
    #[cfg(target_os = "macos")]
    let download_url = format!(
        "https://api.adoptium.net/v3/binary/latest/{major}/ga/mac/x64/jre/hotspot/normal/eclipse"
    );
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    return Err("Esta plataforma no tiene descarga automática de Java configurada.".into());

    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|e| format!("No se pudo preparar la descarga de Java: {e}"))?
        .get(download_url)
        .send()
        .map_err(|e| format!("No se pudo descargar Java {major}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("El servidor rechazó la descarga de Java: {e}"))?;
    let bytes = response
        .bytes()
        .map_err(|e| format!("La descarga de Java quedó incompleta: {e}"))?;
    let archive_path = app_data.join(format!("java-{major}.zip"));
    std::fs::write(&archive_path, &bytes).map_err(|e| format!("No se pudo guardar Java: {e}"))?;
    std::fs::create_dir_all(&runtime_root).map_err(|e| format!("No se pudo preparar Java: {e}"))?;
    let file = std::fs::File::open(&archive_path)
        .map_err(|e| format!("No se pudo abrir el paquete de Java: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("El paquete descargado de Java no es válido: {e}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("No se pudo leer Java: {e}"))?;
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let destination = runtime_root.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&destination)
                .map_err(|e| format!("No se pudo extraer Java: {e}"))?;
        } else {
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("No se pudo extraer Java: {e}"))?;
            }
            let mut output = std::fs::File::create(&destination)
                .map_err(|e| format!("No se pudo extraer Java: {e}"))?;
            std::io::copy(&mut entry, &mut output)
                .map_err(|e| format!("No se pudo extraer Java: {e}"))?;
        }
    }
    let _ = std::fs::remove_file(archive_path);
    find_file(&runtime_root, executable_name)
        .ok_or_else(|| "Java se descargó, pero no se encontró su ejecutable.".into())
}

fn find_file(root: &Path, file_name: &str) -> Option<PathBuf> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let entries = std::fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.file_name().and_then(|n| n.to_str()) == Some(file_name) {
                return Some(path);
            }
            if entry.file_type().ok()?.is_dir() {
                pending.push(path);
            }
        }
    }
    None
}

/// Comando: game_kill
#[tauri::command]
pub async fn game_kill(
    state: tauri::State<'_, GameManager>,
    instance_id: String,
) -> Result<serde_json::Value, String> {
    if let Some(tx) = state.cancel_tokens.lock().await.get(&instance_id) {
        let _ = tx.send(true);
        Ok(serde_json::json!({ "killed": true }))
    } else {
        Ok(serde_json::json!({ "killed": false }))
    }
}

// --- Helpers ---

fn emit_state(app: &AppHandle, instance_id: &str, state: GameState, pid: Option<u32>) {
    let event = GameStateEvent {
        instance_id: instance_id.to_string(),
        state,
        pid,
        timestamp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    let _ = app.emit("game://state-changed", event);
}

fn chrono_like_timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}.{:03}", now.as_secs(), now.subsec_millis())
}

/// Redacta tokens sensibles (hex largos) y rutas/nombres `.jar` en una sola pasada.
fn redact_tokens(text: &str) -> String {
    let secrets = Regex::new(r#"(?i)(--(?:accessToken|clientToken|refreshToken)|access_token|refresh_token)([=:\s,]+)(?:"[^"]*"|'[^']*'|[^\s,\]]+)"#).unwrap();
    let text = secrets.replace_all(text, "$1$2[REDACTED]");
    let jwt = Regex::new(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+").unwrap();
    let text = jwt.replace_all(&text, "[REDACTED]");
    let re = Regex::new(r"([a-f0-9]{32,})").unwrap();
    let without_tokens = re.replace_all(&text, "[REDACTED]").to_string();
    vault::redact_jar_paths(&without_tokens)
}

fn append_launch_log(log: &StdMutex<Option<std::fs::File>>, text: &str) {
    // Persist exceptions printed before Minecraft can create a crash report.
    if let Ok(mut writer) = log.lock() {
        if let Some(file) = writer.as_mut() {
            if file.metadata().map(|metadata| metadata.len() < 4 * 1024 * 1024).unwrap_or(false) {
                let _ = writeln!(file, "{}", redact_tokens(text));
            }
        }
    }
}

fn diagnose_crash(exit_code: i32, crash_reports_dir: &str) -> CrashDiagnostic {
    let mut probable_causes = Vec::new();

    let _patterns = vec![
        (
            r"java\.lang\.OutOfMemoryError",
            "Memoria insuficiente (OutOfMemoryError)",
        ),
        (
            r"UnsupportedClassVersionError",
            "Versión de Java incompatible",
        ),
        (
            r"java\.lang\.NullPointerException",
            "NullPointerException (posible mod incompatibilidad)",
        ),
        (r"Mod.*failed to load", "Fallo al cargar un mod"),
        (
            r"Exception in thread.*main",
            "Excepción en el hilo principal",
        ),
    ];

    if exit_code != 0 {
        probable_causes.push(
            "El proceso terminó con código de error. Revise los logs para más detalles.".into(),
        );
    }

    CrashDiagnostic {
        exit_code,
        probable_causes,
        crash_report_path: Some(format!("{crash_reports_dir}/crash-{exit_code}.txt")),
        exception_summary: None,
    }
}
