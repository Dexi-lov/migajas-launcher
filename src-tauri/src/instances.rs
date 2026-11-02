use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const MANAGED_BY: &str = "migajas-launcher";
const WHITELIST_DENIED: &str = "No estás autorizado en la whitelist de este evento.";
const WHITELIST_UNAVAILABLE: &str = "No se pudo verificar la lista de acceso del evento.";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WhitelistConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, rename = "type")]
    pub whitelist_type: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub allowed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhitelistResult {
    pub allowed: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigajasMetadata {
    pub managed_by: String,
    pub version: String,
    pub instance_id: String,
    pub created_at: u64,
}

#[derive(Debug, Deserialize)]
struct InstanceConfig {
    #[serde(default)]
    whitelist: Option<WhitelistConfig>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInstanceInfo {
    pub instance_id: String,
    pub name: String,
    pub managed_by_migajas: bool,
    pub legacy: bool,
    pub installed: bool,
    pub manifest: serde_json::Value,
}

fn local_manifest(config: &serde_json::Value, instance_id: &str) -> serde_json::Value {
    let mut manifest = serde_json::json!({"id": instance_id});
    // Download links can be temporary signed URLs. Resolve them again when playing.
    for key in ["nombre_evento", "icono", "logo", "imagen", "imagen_evento", "imagen_fondo",
        "banner", "version_mc", "tipo_loader", "loader_version", "java_version", "archived", "managed_pack"] {
        if let Some(value) = config.get(key) {
            manifest[key] = value.clone();
        }
    }
    manifest
}

fn instance_id_is_valid(instance_id: &str) -> bool {
    !instance_id.is_empty()
        && instance_id.len() <= 64
        && instance_id != "."
        && instance_id != ".."
        && instance_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn instances_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("instances"))
        .map_err(|e| format!("No se pudo resolver la carpeta de datos de la aplicación: {e}"))
}

fn instance_path(app: &AppHandle, instance_id: &str) -> Result<PathBuf, String> {
    if !instance_id_is_valid(instance_id) {
        return Err("instance_id inválido".into());
    }
    Ok(instances_root(app)?.join(instance_id))
}

fn allowed_result() -> WhitelistResult {
    WhitelistResult {
        allowed: true,
        reason: String::new(),
    }
}

fn denied_result(reason: &str) -> WhitelistResult {
    WhitelistResult {
        allowed: false,
        reason: reason.into(),
    }
}

fn normalize_uuid(value: &str) -> String {
    value
        .chars()
        .filter(|c| *c != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

async fn check_whitelist(
    app: &AppHandle,
    instance_id: &str,
    profile_uuid: &str,
    username: &str,
) -> Result<WhitelistResult, String> {
    let config_path = instance_path(app, instance_id)?.join("instance_config.json");
    let config_text = match tokio::fs::read_to_string(config_path).await {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(allowed_result()),
        Err(error) => {
            return Err(format!(
                "No se pudo leer la configuración de la instancia: {error}"
            ));
        }
    };

    let instance_config: InstanceConfig = serde_json::from_str(&config_text)
        .map_err(|e| format!("La configuración de la instancia no contiene JSON válido: {e}"))?;
    let Some(whitelist) = instance_config.whitelist else {
        return Ok(allowed_result());
    };
    if !whitelist.enabled {
        return Ok(allowed_result());
    }

    let allowed = match whitelist.whitelist_type.to_ascii_lowercase().as_str() {
        "remote" => match whitelist.url.as_deref() {
            Some(url) => {
                let parsed_url = match reqwest::Url::parse(url) {
                    Ok(url) if url.scheme() == "https" => url,
                    _ => return Ok(denied_result(WHITELIST_UNAVAILABLE)),
                };
                let client = match reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(5))
                    .build()
                {
                    Ok(client) => client,
                    Err(_) => return Ok(denied_result(WHITELIST_UNAVAILABLE)),
                };
                let response = match client.get(parsed_url).send().await {
                    Ok(response) => response,
                    Err(_) => return Ok(denied_result(WHITELIST_UNAVAILABLE)),
                };
                let response = match response.error_for_status() {
                    Ok(response) => response,
                    Err(_) => return Ok(denied_result(WHITELIST_UNAVAILABLE)),
                };
                match response.json::<Vec<String>>().await {
                    Ok(entries) => entries,
                    Err(_) => return Ok(denied_result(WHITELIST_UNAVAILABLE)),
                }
            }
            None => whitelist.allowed,
        },
        "local" => whitelist.allowed,
        _ => return Ok(denied_result(WHITELIST_UNAVAILABLE)),
    };

    let username_key = username.trim().to_lowercase();
    let uuid_key = normalize_uuid(profile_uuid);
    let matches = allowed.iter().any(|entry| {
        let entry = entry.trim();
        !entry.is_empty()
            && (entry.to_lowercase() == username_key || normalize_uuid(entry) == uuid_key)
    });

    if matches {
        Ok(allowed_result())
    } else {
        Ok(denied_result(WHITELIST_DENIED))
    }
}

pub(crate) async fn check_saved_profile_whitelist(
    app: &AppHandle,
    instance_id: &str,
    profile_uuid: &str,
) -> Result<WhitelistResult, String> {
    match crate::auth::saved_profile_username(app, profile_uuid).await {
        Some(username) => check_whitelist(app, instance_id, profile_uuid, &username).await,
        None => {
            let config_path = instance_path(app, instance_id)?.join("instance_config.json");
            let config_text = match tokio::fs::read_to_string(config_path).await {
                Ok(text) => text,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(allowed_result());
                }
                Err(error) => {
                    return Err(format!(
                        "No se pudo leer la configuración de la instancia: {error}"
                    ));
                }
            };
            let instance_config: InstanceConfig =
                serde_json::from_str(&config_text).map_err(|e| {
                    format!("La configuración de la instancia no contiene JSON válido: {e}")
                })?;
            if instance_config
                .whitelist
                .is_some_and(|whitelist| whitelist.enabled)
            {
                Ok(denied_result(WHITELIST_DENIED))
            } else {
                Ok(allowed_result())
            }
        }
    }
}

#[tauri::command]
pub async fn check_instance_whitelist(
    app: AppHandle,
    instance_id: String,
    profile_uuid: String,
    username: String,
) -> Result<WhitelistResult, String> {
    check_whitelist(&app, &instance_id, &profile_uuid, &username).await
}

#[tauri::command]
pub fn is_migajas_instance(app: AppHandle, instance_id: String) -> Result<bool, String> {
    is_migajas_instance_inner(&app, &instance_id)
}

fn is_migajas_instance_inner(app: &AppHandle, instance_id: &str) -> Result<bool, String> {
    let directory = instance_path(app, instance_id)?;
    let directory_metadata = match std::fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("No se pudo comprobar la instancia: {error}")),
    };
    if !directory_metadata.is_dir() || directory_metadata.file_type().is_symlink() {
        return Ok(false);
    }

    let metadata_path = directory.join("migajas.instance.json");
    match std::fs::symlink_metadata(&metadata_path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "No se pudieron comprobar los metadatos de la instancia: {error}"
            ));
        }
    }
    let contents = match std::fs::read_to_string(metadata_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "No se pudieron leer los metadatos de la instancia: {error}"
            ));
        }
    };
    let metadata: MigajasMetadata = match serde_json::from_str(&contents) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(false),
    };
    Ok(metadata.managed_by == MANAGED_BY && metadata.instance_id == instance_id)
}

fn legacy_instance_name(directory: &Path, instance_id: &str) -> Option<String> {
    let config_path = directory.join("instance_config.json");
    let file_metadata = std::fs::symlink_metadata(&config_path).ok()?;
    if !file_metadata.is_file() || file_metadata.file_type().is_symlink() {
        return None;
    }
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(config_path).ok()?).ok()?;
    if config.get("id")?.as_str()? != instance_id {
        return None;
    }
    let pack_url = config.get("url_modpack")?.as_str()?;
    if !pack_url.starts_with("https://") {
        return None;
    }
    let name = config
        .get("nombre_evento")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(instance_id)
        .trim();
    Some(name.chars().take(120).collect())
}

#[tauri::command]
pub fn list_local_instances(app: AppHandle) -> Result<Vec<LocalInstanceInfo>, String> {
    let root = instances_root(&app)?;
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "No se pudieron listar las instancias locales: {error}"
            ));
        }
    };
    let mut instances = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("No se pudo leer una instancia local: {error}"))?;
        let metadata = entry
            .file_type()
            .map_err(|error| format!("No se pudo comprobar una instancia local: {error}"))?;
        if !metadata.is_dir() || metadata.is_symlink() {
            continue;
        }
        let Some(instance_id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !instance_id_is_valid(&instance_id) {
            continue;
        }
        let managed_by_migajas = is_migajas_instance_inner(&app, &instance_id)?;
        let config = std::fs::read(entry.path().join("instance_config.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .unwrap_or_default();
        let name = if managed_by_migajas {
            config
                .get("nombre_evento")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| instance_id.clone())
        } else if let Some(name) = legacy_instance_name(&entry.path(), &instance_id) {
            name
        } else {
            continue;
        };
        instances.push(LocalInstanceInfo {
            installed: entry.path().join("pack_info.json").is_file(),
            manifest: local_manifest(&config, &instance_id),
            instance_id,
            name,
            managed_by_migajas,
            legacy: !managed_by_migajas,
        });
    }
    instances.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(instances)
}

#[tauri::command]
pub fn delete_previous_instance(app: AppHandle, instance_id: String) -> Result<bool, String> {
    let directory = instance_path(&app, &instance_id)?;
    if !is_migajas_instance_inner(&app, &instance_id)?
        && legacy_instance_name(&directory, &instance_id).is_none()
    {
        return Err("No se pudo verificar que esta carpeta pertenezca a una instancia de Migajas Launcher. No se eliminó.".into());
    }

    let root = instances_root(&app)?;
    let canonical_root = std::fs::canonicalize(&root)
        .map_err(|e| format!("No se pudo resolver la carpeta de instancias: {e}"))?;
    let directory_metadata = std::fs::symlink_metadata(&directory)
        .map_err(|e| format!("No se pudo comprobar la instancia: {e}"))?;
    if !directory_metadata.is_dir() || directory_metadata.file_type().is_symlink() {
        return Err("La ruta de la instancia no es una carpeta segura.".into());
    }
    let canonical_directory = std::fs::canonicalize(&directory)
        .map_err(|e| format!("No se pudo resolver la ruta de la instancia: {e}"))?;
    if canonical_directory.parent() != Some(canonical_root.as_path()) {
        return Err("La ruta de la instancia está fuera de la carpeta permitida.".into());
    }
    std::fs::remove_dir_all(canonical_directory)
        .map_err(|e| format!("No se pudo eliminar la instancia: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn delete_instance(app: AppHandle, instance_id: String) -> Result<bool, String> {
    if !is_migajas_instance(app.clone(), instance_id.clone())? {
        return Err(
            "Esta carpeta no fue creada por Migajas Launcher. Operación cancelada por seguridad."
                .into(),
        );
    }

    let root = instances_root(&app)?;
    let canonical_root = std::fs::canonicalize(&root)
        .map_err(|e| format!("No se pudo resolver la carpeta de instancias: {e}"))?;
    let directory = instance_path(&app, &instance_id)?;
    let directory_metadata = std::fs::symlink_metadata(&directory)
        .map_err(|e| format!("No se pudo comprobar la instancia: {e}"))?;
    if !directory_metadata.is_dir() || directory_metadata.file_type().is_symlink() {
        return Err("La ruta de la instancia no es una carpeta segura.".into());
    }
    let canonical_directory = std::fs::canonicalize(&directory)
        .map_err(|e| format!("No se pudo resolver la ruta de la instancia: {e}"))?;
    if canonical_directory.parent() != Some(canonical_root.as_path()) {
        return Err("La ruta de la instancia está fuera de la carpeta permitida.".into());
    }

    std::fs::remove_dir_all(canonical_directory)
        .map_err(|e| format!("No se pudo eliminar la instancia: {e}"))?;
    Ok(true)
}

pub fn create_instance_metadata(instance_dir: &Path, instance_id: &str) -> std::io::Result<()> {
    if !instance_id_is_valid(instance_id) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "instance_id inválido",
        ));
    }
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let metadata = MigajasMetadata {
        managed_by: MANAGED_BY.into(),
        version: env!("CARGO_PKG_VERSION").into(),
        instance_id: instance_id.into(),
        created_at,
    };
    let bytes = serde_json::to_vec_pretty(&metadata)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::create_dir_all(instance_dir)?;
    std::fs::write(instance_dir.join("migajas.instance.json"), bytes)
}

#[cfg(test)]
mod local_manifest_tests {
    #[test]
    fn installed_event_summary_preserves_artwork_without_download_credentials() {
        let config = serde_json::json!({"id":"untrusted", "nombre_evento":"Evento anterior",
            "archived":true,"managed_pack":true,"icono":"https://example.invalid/icon.png",
            "url_modpack":"https://example.invalid/pack?token=private", "admin_code":"private"});
        let summary = super::local_manifest(&config, "archive-test");
        assert_eq!(summary["id"], "archive-test");
        assert_eq!(summary["archived"], true);
        assert_eq!(summary["icono"], config["icono"]);
        assert!(summary.get("url_modpack").is_none());
        assert!(summary.get("admin_code").is_none());
    }
}
