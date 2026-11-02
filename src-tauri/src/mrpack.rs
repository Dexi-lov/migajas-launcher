use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub format_version: u32,
    pub game: String,
    pub dependencies: HashMap<String, String>,
    pub files: Vec<PackFile>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackFile {
    pub path: String,
    pub hashes: HashMap<String, String>,
    pub downloads: Vec<String>,
    pub file_size: u64,
    #[serde(default)]
    pub env: HashMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Runtime {
    pub version_mc: String,
    pub tipo_loader: String,
    pub loader_version: Option<String>,
    pub java_version: String,
    pub url_loader: Option<String>,
}
pub fn safe_path(value: &str) -> Result<PathBuf, String> {
    let normalized = value.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.split('/').any(|p| {
            p.is_empty()
                || p == "."
                || p == ".."
                || p.contains(':')
                || p.ends_with(['.', ' '])
                || p.chars().any(|c| c < ' ' || "<>\"|?*".contains(c))
        })
    {
        return Err("El paquete contiene una ruta insegura.".into());
    }
    let first = normalized.split('/').next().unwrap().to_ascii_lowercase();
    if [
        "instance_config.json",
        "migajas.instance.json",
        "pack_info.json",
        ".vault",
    ]
    .contains(&first.as_str())
    {
        return Err("El paquete intenta modificar metadatos del launcher.".into());
    }
    for part in normalized.split('/') {
        let stem = part.split('.').next().unwrap().to_ascii_uppercase();
        if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err("Nombre de archivo incompatible con Windows.".into());
        }
    }
    Ok(PathBuf::from(normalized))
}
fn allowed_url(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|u| {
        u.scheme() == "https"
            && u.username().is_empty()
            && u.password().is_none()
            && matches!(
                u.host_str(),
                Some(
                    "cdn.modrinth.com"
                        | "github.com"
                        | "raw.githubusercontent.com"
                        | "gitlab.com"
                        | "objects.githubusercontent.com"
                        | "release-assets.githubusercontent.com"
                )
            )
    })
}
impl Index {
    pub fn runtime(&self) -> Result<Runtime, String> {
        if self.format_version != 1 || self.game != "minecraft" {
            return Err("Formato MRPACK no compatible.".into());
        }
        let minecraft = self
            .dependencies
            .get("minecraft")
            .filter(|v| !v.trim().is_empty())
            .ok_or("El MRPACK no especifica Minecraft.")?
            .clone();
        if self.dependencies.contains_key("quilt-loader") {
            return Err(
                "Este paquete requiere Quilt, un loader todavía no soportado por Migajas.".into(),
            );
        }
        let loaders = [
            ("fabric-loader", "fabric"),
            ("forge", "forge"),
            ("neoforge", "neoforge"),
        ];
        let found: Vec<_> = loaders
            .iter()
            .filter_map(|(key, name)| self.dependencies.get(*key).map(|v| (*name, v.clone())))
            .collect();
        if found.len() > 1 {
            return Err("El MRPACK define más de un loader.".into());
        }
        let (loader, mut version) = found
            .first()
            .map(|(k, v)| ((*k).to_owned(), Some(v.clone())))
            .unwrap_or(("vanilla".into(), None));
        let parts: Vec<u32> = minecraft
            .split('.')
            .filter_map(|p| p.parse().ok())
            .collect();
        let minor = parts.get(1).copied().unwrap_or(21);
        let patch = parts.get(2).copied().unwrap_or(0);
        let java = if minor > 20 || (minor == 20 && patch >= 5) {
            "21"
        } else if minor >= 17 {
            "17"
        } else {
            "8"
        };
        if loader == "forge" {
            if let Some(value) = version.as_mut() {
                if !value.starts_with(&format!("{minecraft}-")) {
                    *value = format!("{minecraft}-{value}");
                }
            }
        }
        let installer = match (loader.as_str(), version.as_deref()) {
            ("forge", Some(value)) => Some(mc_launcher_core::loader::forge::installer_url(value)),
            ("neoforge", Some(value)) => {
                Some(mc_launcher_core::loader::neoforge::installer_url(value))
            }
            _ => None,
        };
        Ok(Runtime {
            version_mc: minecraft,
            tipo_loader: loader,
            loader_version: version,
            java_version: java.into(),
            url_loader: installer,
        })
    }
    pub fn validate(&self) -> Result<(), String> {
        self.runtime()?;
        if self.files.len() > 50000 {
            return Err("El MRPACK contiene demasiados archivos.".into());
        }
        let mut seen = HashSet::new();
        let mut size = 0u64;
        for file in &self.files {
            safe_path(&file.path)?;
            if !seen.insert(file.path.replace('\\', "/").to_lowercase()) {
                return Err("El MRPACK contiene rutas duplicadas.".into());
            }
            for (name, len) in [("sha1", 40), ("sha512", 128)] {
                if !file
                    .hashes
                    .get(name)
                    .is_some_and(|v| v.len() == len && v.bytes().all(|c| c.is_ascii_hexdigit()))
                {
                    return Err(format!("El MRPACK contiene un hash {name} inválido."));
                }
            }
            if file.downloads.is_empty() || file.downloads.iter().any(|u| !allowed_url(u)) {
                return Err("El MRPACK contiene un origen de descarga no autorizado.".into());
            }
            if file
                .env
                .values()
                .any(|v| !["required", "optional", "unsupported"].contains(&v.as_str()))
            {
                return Err("Entorno MRPACK inválido.".into());
            }
            size = size
                .checked_add(file.file_size)
                .ok_or("Tamaño de MRPACK inválido.")?;
            if file.file_size > 2 * 1024 * 1024 * 1024 || size > 8 * 1024 * 1024 * 1024 {
                return Err("El MRPACK supera los límites de tamaño.".into());
            }
        }
        Ok(())
    }
}
pub fn read_index(path: &Path) -> Result<Option<Index>, String> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let entry = zip.by_name("modrinth.index.json");
    match entry {
        Err(zip::result::ZipError::FileNotFound) => Ok(None),
        Err(e) => Err(e.to_string()),
        Ok(mut file) => {
            if file.size() > 2 * 1024 * 1024 {
                return Err("Índice MRPACK demasiado grande.".into());
            }
            let mut bytes = Vec::new();
            file.by_ref()
                .take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 2 * 1024 * 1024 {
                return Err("Índice MRPACK demasiado grande.".into());
            }
            let index: Index = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Índice MRPACK inválido: {e}"))?;
            index.validate()?;
            Ok(Some(index))
        }
    }
}
fn cancelled(cancel: &watch::Receiver<bool>) -> Result<(), String> {
    if *cancel.borrow() {
        Err("Descarga cancelada.".into())
    } else {
        Ok(())
    }
}
fn valid_hashes(file: &PackFile, size: u64, sha1: &str, sha512: &str) -> bool {
    size == file.file_size
        && file
            .hashes
            .get("sha1")
            .is_some_and(|v| v.eq_ignore_ascii_case(sha1))
        && file
            .hashes
            .get("sha512")
            .is_some_and(|v| v.eq_ignore_ascii_case(sha512))
}
pub fn install(
    app: &AppHandle,
    instance_id: &str,
    archive: &Path,
    stage: &Path,
    index: &Index,
    cancel: &watch::Receiver<bool>,
    limit_kbps: u64,
) -> Result<Runtime, String> {
    index.validate()?;
    let runtime = index.runtime()?;
    let client = reqwest::blocking::Client::builder()
        .user_agent("MigajasLauncher/1.2.5")
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(24 * 3600))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !allowed_url(attempt.url().as_str()) {
                attempt.error("Redirección no autorizada")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    let files: Vec<_> = index
        .files
        .iter()
        .filter(|f| f.env.get("client").map(String::as_str) != Some("unsupported"))
        .collect();
    let total: u64 = files.iter().map(|f| f.file_size).sum();
    let start = Instant::now();
    let mut transferred = 0u64;
    for file in files {
        cancelled(cancel)?;
        let path = stage.join(safe_path(&file.path)?);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut installed = false;
        for url in &file.downloads {
            let result = (|| -> Result<(), String> {
                let mut response = client
                    .get(url)
                    .send()
                    .and_then(|r| r.error_for_status())
                    .map_err(|e| e.to_string())?;
                let mut out = std::fs::File::create(&path).map_err(|e| e.to_string())?;
                let mut sha512 = Sha512::new();
                let mut sha1 = sha1::Sha1::new();
                let mut size = 0u64;
                let mut buffer = vec![0u8; 65536];
                loop {
                    cancelled(cancel)?;
                    let n = response.read(&mut buffer).map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    size += n as u64;
                    transferred += n as u64;
                    if size > file.file_size {
                        return Err("El archivo supera el tamaño publicado.".into());
                    }
                    sha512.update(&buffer[..n]);
                    sha1.update(&buffer[..n]);
                    out.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
                    if limit_kbps > 0 {
                        let expected = Duration::from_secs_f64(
                            transferred as f64 / (limit_kbps.saturating_mul(1024)) as f64,
                        );
                        while start.elapsed() < expected {
                            cancelled(cancel)?;
                            std::thread::sleep(Duration::from_millis(30));
                        }
                    }
                    let _=app.emit("sync://progress",serde_json::json!({"instanceId":instance_id,"stage":"DOWNLOADING_MODPACK","currentFile":"Descargando archivos del evento…","bytesProcessed":transferred.min(total),"bytesTotal":total,"filesProcessed":0,"filesTotal":index.files.len(),"speedBps":0,"etaSeconds":0}));
                }
                if !valid_hashes(
                    file,
                    size,
                    &format!("{:x}", sha1.finalize()),
                    &format!("{:x}", sha512.finalize()),
                ) {
                    return Err("El archivo no coincide con sus hashes publicados.".into());
                }
                out.flush().map_err(|e| e.to_string())?;
                Ok(())
            })();
            if result.is_ok() {
                installed = true;
                break;
            }
            cancelled(cancel)?;
        }
        if !installed {
            return Err("No se pudo descargar o verificar un archivo del evento. Reintenta la descarga o avisa a un administrador.".into());
        }
    }
    extract_overrides(archive, stage, cancel)?;
    Ok(runtime)
}
fn extract_overrides(
    archive: &Path,
    stage: &Path,
    cancel: &watch::Receiver<bool>,
) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut expanded = 0u64;
    for prefix in ["overrides/", "client-overrides/"] {
        for i in 0..zip.len() {
            cancelled(cancel)?;
            let entry = zip.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().replace('\\', "/");
            let Some(relative) = name.strip_prefix(prefix) else {
                continue;
            };
            if entry.is_dir() {
                continue;
            }
            let path = stage.join(safe_path(relative)?);
            expanded = expanded
                .checked_add(entry.size())
                .ok_or("Paquete demasiado grande.")?;
            if expanded > 8 * 1024 * 1024 * 1024 {
                return Err("Overrides demasiado grandes.".into());
            }
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(path).map_err(|e| e.to_string())?;
            let expected = entry.size();
            let copied = std::io::copy(&mut entry.take(expected.saturating_add(1)), &mut out)
                .map_err(|e| e.to_string())?;
            if copied != expected {
                return Err("Tamaño de override inválido.".into());
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unsafe_paths() {
        for path in [
            "../x",
            "C:/x",
            "/mods/a.jar",
            "mods/../../x",
            "mods/CON.jar",
            "instance_config.json",
            ".vault/a",
        ] {
            assert!(safe_path(path).is_err(), "{path}");
        }
        assert!(safe_path("mods/a.jar").is_ok());
    }
    #[test]
    fn reads_loader_and_rejects_quilt() {
        let mut index = Index {
            format_version: 1,
            game: "minecraft".into(),
            dependencies: HashMap::from([
                ("minecraft".into(), "1.21.1".into()),
                ("fabric-loader".into(), "0.16.14".into()),
            ]),
            files: vec![],
        };
        assert_eq!(index.runtime().unwrap().tipo_loader, "fabric");
        index.dependencies.insert("quilt-loader".into(), "1".into());
        assert!(index.runtime().is_err());
    }
    #[test]
    fn restricts_download_origins() {
        assert!(allowed_url(
            "https://cdn.modrinth.com/data/a/versions/b/mod.jar"
        ));
        assert!(!allowed_url("https://localhost/a"));
        assert!(!allowed_url("http://cdn.modrinth.com/a"));
    }
}

#[cfg(test)]
mod archive_tests {
    use super::*;
    #[test]
    fn index_and_override_layers_are_installed_for_client() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("test.mrpack");
        let stage = temp.path().join("stage");
        std::fs::create_dir(&stage).unwrap();
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in [
            ("client-overrides/config/test.txt", "client"),
            ("overrides/config/test.txt", "base"),
            ("server-overrides/server.txt", "server"),
            (
                "modrinth.index.json",
                r#"{"formatVersion":1,"game":"minecraft","dependencies":{"minecraft":"1.20.5","fabric-loader":"0.16.14"},"files":[]}"#,
            ),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(data.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let index = read_index(&archive).unwrap().unwrap();
        assert_eq!(index.runtime().unwrap().java_version, "21");
        let (_tx, rx) = watch::channel(false);
        extract_overrides(&archive, &stage, &rx).unwrap();
        assert_eq!(
            std::fs::read_to_string(stage.join("config/test.txt")).unwrap(),
            "client"
        );
        assert!(!stage.join("server.txt").exists());
        assert!(!stage.join("modrinth.index.json").exists());
    }
    #[test]
    fn invalid_file_hashes_are_rejected_before_download() {
        let index = Index {
            format_version: 1,
            game: "minecraft".into(),
            dependencies: HashMap::from([("minecraft".into(), "1.21.1".into())]),
            files: vec![PackFile {
                path: "mods/test.jar".into(),
                hashes: HashMap::from([
                    ("sha1".into(), "invalid".into()),
                    ("sha512".into(), "a".repeat(128)),
                ]),
                downloads: vec!["https://cdn.modrinth.com/test.jar".into()],
                file_size: 10,
                env: HashMap::new(),
            }],
        };
        assert!(index.validate().is_err());
    }
}

#[cfg(test)]
mod integrity_tests {
    use super::*;
    #[test]
    fn checks_both_hashes_and_size() {
        let data = b"test mod";
        let sha1 = format!("{:x}", sha1::Sha1::digest(data));
        let sha512 = format!("{:x}", Sha512::digest(data));
        let file = PackFile {
            path: "mods/test.jar".into(),
            hashes: HashMap::from([
                ("sha1".into(), sha1.clone()),
                ("sha512".into(), sha512.clone()),
            ]),
            downloads: vec![],
            file_size: data.len() as u64,
            env: HashMap::new(),
        };
        assert!(valid_hashes(&file, data.len() as u64, &sha1, &sha512));
        assert!(!valid_hashes(
            &file,
            data.len() as u64,
            &"0".repeat(40),
            &sha512
        ));
        assert!(!valid_hashes(
            &file,
            data.len() as u64,
            &sha1,
            &"0".repeat(128)
        ));
        assert!(!valid_hashes(&file, 1, &sha1, &sha512));
    }
    #[test]
    fn stops_when_cancelled() {
        let (tx, rx) = watch::channel(false);
        assert!(cancelled(&rx).is_ok());
        tx.send(true).unwrap();
        assert!(cancelled(&rx).is_err());
    }
}

#[cfg(test)]
mod forge_runtime_tests {
    use super::*;
    #[test]
    fn forge_has_a_complete_installer_version() {
        let index = Index {
            format_version: 1,
            game: "minecraft".into(),
            dependencies: HashMap::from([
                ("minecraft".into(), "1.20.1".into()),
                ("forge".into(), "47.2.0".into()),
            ]),
            files: vec![],
        };
        let runtime = index.runtime().unwrap();
        assert_eq!(runtime.loader_version.as_deref(), Some("1.20.1-47.2.0"));
        assert!(runtime
            .url_loader
            .unwrap()
            .ends_with("forge-1.20.1-47.2.0-installer.jar"));
    }
    #[test]
    fn neoforge_has_an_installer_url() {
        let index = Index {
            format_version: 1,
            game: "minecraft".into(),
            dependencies: HashMap::from([
                ("minecraft".into(), "1.21.1".into()),
                ("neoforge".into(), "21.1.1".into()),
            ]),
            files: vec![],
        };
        assert!(index
            .runtime()
            .unwrap()
            .url_loader
            .unwrap()
            .starts_with("https://maven.neoforged.net/"));
    }
}
