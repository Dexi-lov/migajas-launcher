use crate::types::*;
use futures_util::StreamExt;
#[cfg(test)]
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::fs::{self, File};
#[cfg(test)]
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct SyncManager {
    pub cancellations: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

#[cfg(test)]
pub async fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path).await?;
    let mut hasher = Sha1::new();
    let mut buffer = vec![0u8; 8192];
    loop {
        let n = file.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
pub async fn instance_sync(
    app: AppHandle,
    state: tauri::State<'_, SyncManager>,
    req: SyncRequest,
) -> Result<serde_json::Value, String> {
    let instance_id = req.instance_id.trim().to_string();
    if instance_id.is_empty()
        || instance_id.len() > 64
        || !instance_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("Identificador de instancia inválido.".into());
    }

    let instance_root = crate::options::instance_dir(&app, &instance_id)?;
    fs::create_dir_all(&instance_root)
        .await
        .map_err(|e| format!("No se pudo crear la instancia: {e}"))?;

    let config_path = instance_root.join("instance_config.json");
    let config = fs::read(&config_path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let mut persisted_config = config.clone();
    if let Some(manifest) = req.manifest.as_ref().and_then(serde_json::Value::as_object) {
        if let Some(target) = persisted_config.as_object_mut() {
            for (key, value) in manifest {
                target.insert(key.clone(), value.clone());
            }
        }
    }
    let config_bytes = serde_json::to_vec_pretty(&persisted_config)
        .map_err(|e| format!("No se pudo guardar la configuración del evento: {e}"))?;
    fs::write(&config_path, config_bytes)
        .await
        .map_err(|e| format!("No se pudo guardar la configuración del evento: {e}"))?;
    let url = req
        .url_modpack
        .clone()
        .or_else(|| {
            config
                .get("url_modpack")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        })
        .ok_or_else(|| {
            "Este evento no tiene una URL de descarga de modpack configurada.".to_string()
        })?;
    let version = req
        .version_pack
        .or_else(|| config.get("version_pack").and_then(|v| v.as_u64()))
        .unwrap_or(1);
    if !url.starts_with("https://") {
        return Err("La URL del modpack debe usar HTTPS.".into());
    }

    let cache_key = req
        .manifest
        .as_ref()
        .and_then(|manifest| manifest.get("pack_cache_key"))
        .and_then(|value| value.as_str())
        .unwrap_or(&url)
        .to_owned();
    let pack_info = instance_root.join("pack_info.json");
    if !req.force_repair {
        if let Ok(bytes) = fs::read(&pack_info).await {
            let installed = serde_json::from_slice::<serde_json::Value>(&bytes).ok();
            if installed
                .as_ref()
                .and_then(|v| v.get("version").and_then(|v| v.as_u64()))
                == Some(version)
                && installed
                    .as_ref()
                    .and_then(|v| v.get("url").and_then(|v| v.as_str()))
                    == Some(cache_key.as_str())
            {
                // Las versiones anteriores podían dejar los JAR con extensión
                // .disabled y aun así marcar el paquete como instalado.
                activate_pack_mods_if_all_disabled(&instance_root)?;
                return Ok(
                    serde_json::json!({"success": true, "updatedVersion": version, "alreadyCurrent": true, "runtime": installed.as_ref().and_then(|v|v.get("runtime"))}),
                );
            }
        }
    }

    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    {
        let mut cancellations = state.cancellations.lock().await;
        if cancellations.contains_key(&instance_id) {
            return Err("Ya hay una descarga activa para esta instancia.".into());
        }
        cancellations.insert(instance_id.clone(), cancel_tx);
    }
    let work_root = instance_root
        .parent()
        .unwrap_or(&instance_root)
        .to_path_buf();
    let archive_path = work_root.join(format!(".migajas-download-{instance_id}.tmp"));
    let stage = work_root.join(format!(".migajas-staging-{instance_id}"));

    let result = async {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(24 * 3600))
            .build()
            .map_err(|e| format!("No se pudo preparar la descarga: {e}"))?;
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("No se pudo descargar el modpack: {e}"))?
            .error_for_status()
            .map_err(|e| format!("El servidor rechazó la descarga: {e}"))?;
        let total = response.content_length().unwrap_or(0);
        let mut archive_file = File::create(&archive_path)
            .await
            .map_err(|e| format!("No se pudo guardar la descarga: {e}"))?;
        let mut stream = response.bytes_stream();
        let mut downloaded = 0u64;
        let download_started = Instant::now();
        let max_bytes_per_second = req
            .download_limit_kbps
            .filter(|limit| *limit > 0)
            .map(|limit| limit.saturating_mul(1024));
        let mut last_emit = Instant::now();
        emit_progress(&app, &instance_id, "Descargando modpack", downloaded, total);
        loop {
            let next_chunk = tokio::select! {
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() { return Err("Descarga cancelada.".into()); }
                    continue;
                }
                item = stream.next() => item,
            };
            let Some(chunk) = next_chunk else {
                break;
            };
            let chunk = chunk.map_err(|e| format!("La descarga se interrumpió: {e}"))?;
            archive_file
                .write_all(&chunk)
                .await
                .map_err(|e| format!("No se pudo escribir el modpack: {e}"))?;
            downloaded += chunk.len() as u64;
            if let Some(limit) = max_bytes_per_second {
                let target_elapsed = Duration::from_secs_f64(downloaded as f64 / limit as f64);
                let delay = target_elapsed.saturating_sub(download_started.elapsed());
                if !delay.is_zero() {
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {},
                        changed = cancel_rx.changed() => {
                            if changed.is_ok() && *cancel_rx.borrow() { return Err("Descarga cancelada.".into()); }
                        }
                    }
                }
            }
            if last_emit.elapsed() >= Duration::from_millis(120) {
                emit_progress(&app, &instance_id, "Descargando modpack", downloaded, total);
                last_emit = Instant::now();
            }
        }
        archive_file
            .flush()
            .await
            .map_err(|e| format!("No se pudo finalizar la descarga: {e}"))?;
        drop(archive_file);
        if downloaded == 0 {
            return Err("El servidor devolvió un archivo vacío.".into());
        }
        if total > 0 && downloaded != total {
            return Err(format!(
                "La descarga quedó incompleta: se recibieron {downloaded} de {total} bytes."
            ));
        }

        if let Some(expected) = req.manifest.as_ref()
            .and_then(|manifest| manifest.get("sha256"))
            .and_then(|value| value.as_str())
        {
            let expected = expected.to_owned();
            let downloaded_path = archive_path.clone();
            tokio::task::spawn_blocking(move || verify_download_sha256(&downloaded_path, &expected))
                .await.map_err(|error| format!("No se pudo comprobar el ZIP: {error}"))??;
        }
        let _ = fs::remove_dir_all(&stage).await;
        fs::create_dir_all(&stage)
            .await
            .map_err(|e| format!("No se pudo preparar la instalación: {e}"))?;
        let archive_for_extract = archive_path.clone();
        let stage_for_extract = stage.clone();
        emit_progress(&app, &instance_id, "Instalando archivos", downloaded, total);
        let install_app=app.clone();
        let install_id=instance_id.clone();
        let install_cancel=cancel_rx.clone();
        let limit=req.download_limit_kbps.unwrap_or(0);
        let runtime=tokio::task::spawn_blocking(move || {
            match crate::mrpack::read_index(&archive_for_extract)? {
                Some(index)=>crate::mrpack::install(&install_app,&install_id,&archive_for_extract,&stage_for_extract,&index,&install_cancel,limit).map(Some),
                None=>extract_modpack(&archive_for_extract,&stage_for_extract).map(|_|None),
            }
        }).await.map_err(|e|format!("Falló la instalación del modpack: {e}"))??;

        if *cancel_rx.borrow() { return Err("Descarga cancelada.".into()); }
        let destination = instance_root.clone();
        let stage_for_merge = stage.clone();
        tokio::task::spawn_blocking(move || merge_staged_files(&stage_for_merge, &destination))
            .await
            .map_err(|e| format!("Falló la instalación de archivos: {e}"))??;

        activate_pack_mods_if_all_disabled(&instance_root)?;

        if let Some(runtime)=runtime.as_ref() {
            let values=serde_json::to_value(runtime).map_err(|e|e.to_string())?;
            for (key,value) in values.as_object().unwrap() {persisted_config[key]=value.clone();}
            fs::write(&config_path,serde_json::to_vec_pretty(&persisted_config).map_err(|e|e.to_string())?).await.map_err(|e|e.to_string())?;
        }
        let version_json = serde_json::to_vec(&serde_json::json!({"version": version, "url": cache_key,"runtime":runtime}))
            .map_err(|e| format!("No se pudo codificar la versión del modpack: {e}"))?;
        fs::write(&pack_info, version_json)
            .await
            .map_err(|e| format!("No se pudo guardar la versión instalada: {e}"))?;
        let _ = fs::remove_file(&archive_path).await;
        let _ = fs::remove_dir_all(&stage).await;
        crate::instances::create_instance_metadata(&instance_root, &instance_id)
            .map_err(|e| format!("No se pudieron guardar los metadatos de la instancia: {e}"))?;
        emit_progress(&app, &instance_id, "Descarga completada", total, total);
        Ok(serde_json::json!({"success": true, "updatedVersion": version, "alreadyCurrent": false,"runtime":runtime}))
    }
    .await;

    if result.is_err() {
        let _ = fs::remove_file(&archive_path).await;
        let _ = fs::remove_dir_all(&stage).await;
    }
    state.cancellations.lock().await.remove(&instance_id);
    result
}

fn verify_download_sha256(path: &Path, expected: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("La huella SHA-256 del modpack no es válida.".into());
    }
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("No se pudo abrir el ZIP: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("No se pudo comprobar el ZIP: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    if format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err("El modpack descargado no coincide con el publicado. Reintenta la descarga.".into())
    }
}

pub(crate) fn activate_pack_mods_if_all_disabled(instance_root: &Path) -> Result<usize, String> {
    let mods_dir = instance_root.join("mods");
    if !mods_dir.is_dir() {
        return Ok(0);
    }

    let mut pending = vec![mods_dir.clone()];
    let mut active_jars = 0usize;
    let mut disabled_jars = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory)
            .map_err(|error| format!("No se pudo revisar la carpeta de mods: {error}"))?
        {
            let entry = entry.map_err(|error| format!("No se pudo revisar un mod: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("No se pudo comprobar un mod: {error}"))?;
            if file_type.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.to_ascii_lowercase().ends_with(".jar.disabled") {
                disabled_jars.push(path);
            } else if path
                .extension()
                .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("jar"))
            {
                active_jars += 1;
            }
        }
    }

    if active_jars > 0 || disabled_jars.is_empty() {
        return Ok(0);
    }

    let mut activated = 0;
    for disabled in disabled_jars {
        let Some(name) = disabled.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let active = disabled.with_file_name(&name[..name.len() - ".disabled".len()]);
        if active.exists() {
            continue;
        }
        std::fs::rename(&disabled, &active)
            .map_err(|error| format!("No se pudo habilitar el mod {name}: {error}"))?;
        activated += 1;
    }
    Ok(activated)
}

#[tauri::command]
pub async fn instance_cancel_sync(
    state: tauri::State<'_, SyncManager>,
    instance_id: String,
) -> Result<serde_json::Value, String> {
    if let Some(tx) = state.cancellations.lock().await.get(&instance_id) {
        let _ = tx.send(true);
        Ok(serde_json::json!({"canceled": true}))
    } else {
        Ok(serde_json::json!({"canceled": false}))
    }
}

fn extract_modpack(archive_path: &Path, staging: &Path) -> Result<(), String> {
    let file =
        std::fs::File::open(archive_path).map_err(|e| format!("No se pudo abrir el ZIP: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("El archivo descargado no es un ZIP válido: {e}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("ZIP dañado: {e}"))?;
        let name = entry.name().replace('\\', "/");
        if name == "manifest.json" || name == "modrinth.index.json" || name.ends_with('/') {
            continue;
        }
        let relative = name.strip_prefix("overrides/").unwrap_or(&name);
        let relative_path = Path::new(relative);
        if relative_path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("El ZIP contiene una ruta de archivo no segura.".into());
        }
        let target = staging.join(relative_path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("No se pudo preparar una carpeta: {e}"))?;
        }
        let mut output = std::fs::File::create(target)
            .map_err(|e| format!("No se pudo crear un archivo del modpack: {e}"))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|e| format!("No se pudo extraer un archivo del modpack: {e}"))?;
        output
            .flush()
            .map_err(|e| format!("No se pudo finalizar un archivo extraído: {e}"))?;
    }
    Ok(())
}

fn reject_link(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        #[cfg(windows)]
        let reparse = {
            use std::os::windows::fs::MetadataExt;
            metadata.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let reparse = false;
        if metadata.file_type().is_symlink() || reparse {
            return Err("La instalación contiene un enlace de archivos no seguro.".into());
        }
    }
    Ok(())
}
fn merge_staged_files(staging: &Path, destination: &Path) -> Result<(), String> {
    reject_link(destination)?;
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let source = staging.join(&relative);
        for item in std::fs::read_dir(&source)
            .map_err(|e| format!("No se pudo leer el modpack extraído: {e}"))?
        {
            let item = item.map_err(|e| format!("No se pudo leer un archivo extraído: {e}"))?;
            let child_rel = relative.join(item.file_name());
            let metadata = item
                .file_type()
                .map_err(|e| format!("No se pudo comprobar un archivo: {e}"))?;
            let target = destination.join(&child_rel);
            reject_link(&target)?;
            if metadata.is_dir() {
                std::fs::create_dir_all(&target)
                    .map_err(|e| format!("No se pudo crear una carpeta del modpack: {e}"))?;
                pending.push(child_rel);
            } else if metadata.is_file() {
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("No se pudo crear una carpeta de destino: {e}"))?;
                }
                std::fs::copy(item.path(), target)
                    .map_err(|e| format!("No se pudo instalar un archivo del modpack: {e}"))?;
            }
        }
    }
    Ok(())
}

fn emit_progress(
    app: &AppHandle,
    instance_id: &str,
    current_file: &str,
    processed: u64,
    total: u64,
) {
    let event = SyncProgressEvent {
        instance_id: instance_id.to_string(),
        stage: SyncStage::DownloadingModpack,
        current_file: current_file.into(),
        bytes_processed: processed,
        bytes_total: total,
        files_processed: u64::from(total > 0 && processed >= total),
        files_total: 1,
        speed_bps: 0.0,
        eta_seconds: 0.0,
    };
    let _ = app.emit("sync://progress", event);
}

#[cfg(test)]
mod download_integrity_tests {
    use super::verify_download_sha256;
    #[test]
    fn accepts_the_published_archive_and_rejects_tampering() {
        use sha2::{Digest, Sha256};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("modpack.zip");
        std::fs::write(&path, b"published archive").unwrap();
        let expected = format!("{:x}", Sha256::digest(b"published archive"));
        assert!(verify_download_sha256(&path, &expected).is_ok());
        std::fs::write(&path, b"tampered archive").unwrap();
        assert!(verify_download_sha256(&path, &expected).is_err());
        assert!(verify_download_sha256(&path, "invalid").is_err());
    }
}
