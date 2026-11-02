use keyring::Entry;
use reqwest::{Client, Response, StatusCode};
use serde::Serialize;
use serde_json::Value;

const GIST_ID: &str = "8f8babdea6a5bccfe2c2d8a4fe4d8849";
const GIST_OWNER: &str = "Dexi-lov";
const GIST_FILE: &str = "evento_migajas.json";
const LAUNCHER_WHITELIST_FILE: &str = "launcher_whitelist.json";
const KEYRING_SERVICE: &str = "migajas-launcher";
const KEYRING_ACCOUNT: &str = "github-gist-editor-token";
const ADMIN_CODE_ACCOUNT: &str = "github-gist-admin-code-hash";
const GITHUB_API: &str = "https://api.github.com";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GistEditorAccess {
    pub login: String,
    pub gist_url: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherWhitelist {
    pub enabled: bool,
    pub allowed: Vec<String>,
}

impl Default for LauncherWhitelist {
    fn default() -> Self {
        Self {
            enabled: true,
            allowed: Vec::new(),
        }
    }
}

fn token_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("No se pudo abrir el almacén seguro de credenciales: {e}"))
}

fn admin_code_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, ADMIN_CODE_ACCOUNT)
        .map_err(|e| format!("No se pudo abrir el almacén seguro del código administrador: {e}"))
}

fn code_digest(code: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(code.as_bytes()))
}

fn saved_admin_code_hash() -> Result<Option<String>, String> {
    match admin_code_entry()?.get_password() {
        Ok(hash) => Ok(Some(hash)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("No se pudo leer el código administrador: {error}")),
    }
}

fn verify_admin_code(code: &str) -> Result<(), String> {
    let saved = saved_admin_code_hash()?
        .ok_or_else(|| "Primero configura el código administrador desde Ajustes.".to_string())?;
    if code_digest(code.trim()) != saved {
        return Err("Código administrador incorrecto.".into());
    }
    Ok(())
}

fn saved_token() -> Result<Option<String>, String> {
    match token_entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("No se pudo leer la credencial GitHub: {error}")),
    }
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .user_agent("MigajasLauncher/1.1.5")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("No se pudo preparar la conexión con GitHub: {e}"))
}

async fn checked(response: Response) -> Result<Response, String> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let message = match status {
        StatusCode::UNAUTHORIZED => "GitHub rechazó el token. Comprueba que siga vigente.",
        StatusCode::FORBIDDEN => {
            "GitHub denegó el acceso. El token debe tener permiso Gists: write."
        }
        StatusCode::NOT_FOUND => {
            "GitHub no encontró el Gist o el token no tiene permiso para editarlo."
        }
        _ => "GitHub no pudo completar la operación del Gist.",
    };
    Err(format!("{message} (HTTP {})", status.as_u16()))
}

async fn verify_owner(client: &Client, token: &str) -> Result<(String, Value), String> {
    let user_response = client
        .get(format!("{GITHUB_API}/user"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("No se pudo verificar la cuenta de GitHub: {e}"))?;
    let user: Value = checked(user_response)
        .await?
        .json()
        .await
        .map_err(|e| format!("GitHub devolvió una cuenta inválida: {e}"))?;
    let login = user
        .get("login")
        .and_then(Value::as_str)
        .ok_or_else(|| "GitHub no devolvió el nombre de la cuenta.".to_string())?
        .to_string();
    if !login.eq_ignore_ascii_case(GIST_OWNER) {
        return Err(format!(
            "La cuenta autenticada es {login}; solo la cuenta propietaria {GIST_OWNER} puede publicar en este Gist."
        ));
    }

    let gist_response = client
        .get(format!("{GITHUB_API}/gists/{GIST_ID}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("No se pudo comprobar el Gist del launcher: {e}"))?;
    let gist: Value = checked(gist_response)
        .await?
        .json()
        .await
        .map_err(|e| format!("GitHub devolvió un Gist inválido: {e}"))?;
    let owner = gist
        .pointer("/owner/login")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !owner.eq_ignore_ascii_case(GIST_OWNER) {
        return Err("El Gist configurado no pertenece a la cuenta administradora esperada.".into());
    }
    if gist.pointer(&format!("/files/{GIST_FILE}")).is_none() {
        return Err(format!("El Gist no contiene el archivo {GIST_FILE}."));
    }
    Ok((login, gist))
}

#[tauri::command]
pub async fn gist_connect(token: String) -> Result<GistEditorAccess, String> {
    let token = token.trim();
    if token.is_empty() || token.len() > 512 || token.chars().any(char::is_whitespace) {
        return Err("Introduce un token personal de GitHub válido.".into());
    }
    let client = http_client()?;
    let (login, _) = verify_owner(&client, token).await?;
    token_entry()?
        .set_password(token)
        .map_err(|e| format!("No se pudo guardar el token en el almacén seguro: {e}"))?;
    Ok(GistEditorAccess {
        login,
        gist_url: format!("https://gist.github.com/{GIST_OWNER}/{GIST_ID}"),
    })
}

#[tauri::command]
pub async fn gist_editor_status() -> Result<Option<GistEditorAccess>, String> {
    let Some(token) = saved_token()? else {
        return Ok(None);
    };
    let client = http_client()?;
    let (login, _) = verify_owner(&client, &token).await?;
    Ok(Some(GistEditorAccess {
        login,
        gist_url: format!("https://gist.github.com/{GIST_OWNER}/{GIST_ID}"),
    }))
}

#[tauri::command]
pub async fn gist_read_events() -> Result<String, String> {
    let token = saved_token()?
        .ok_or_else(|| "Conecta primero la cuenta administradora de GitHub.".to_string())?;
    let client = http_client()?;
    let (_, gist) = verify_owner(&client, &token).await?;
    gist.pointer(&format!("/files/{GIST_FILE}/content"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "GitHub no devolvió el contenido completo del archivo de eventos.".into())
}

#[tauri::command]
pub async fn gist_publish_events(content: String) -> Result<GistEditorAccess, String> {
    validate_events(&content)?;
    let token = saved_token()?
        .ok_or_else(|| "Conecta primero la cuenta administradora de GitHub.".to_string())?;
    let client = http_client()?;
    let (login, _) = verify_owner(&client, &token).await?;
    let response = client
        .patch(format!("{GITHUB_API}/gists/{GIST_ID}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&serde_json::json!({"files": { (GIST_FILE): {"content": content} }}))
        .send()
        .await
        .map_err(|e| format!("No se pudo publicar la configuración del modpack: {e}"))?;
    checked(response).await?;
    Ok(GistEditorAccess {
        login,
        gist_url: format!("https://gist.github.com/{GIST_OWNER}/{GIST_ID}"),
    })
}

#[tauri::command]
pub fn gist_admin_code_status() -> Result<bool, String> {
    Ok(saved_admin_code_hash()?.is_some())
}

#[tauri::command]
pub async fn gist_set_admin_code(
    code: String,
    current_code: Option<String>,
) -> Result<bool, String> {
    let code = code.trim();
    if code.len() < 8 || code.len() > 128 || code.chars().any(char::is_whitespace) {
        return Err(
            "El código administrador debe tener entre 8 y 128 caracteres y no contener espacios."
                .into(),
        );
    }
    let Some(token) = saved_token()? else {
        return Err("Conecta la cuenta propietaria del Gist antes de configurar el código.".into());
    };
    let client = http_client()?;
    verify_owner(&client, &token).await?;
    if saved_admin_code_hash()?.is_some() {
        verify_admin_code(current_code.as_deref().unwrap_or_default())?;
    }
    admin_code_entry()?
        .set_password(&code_digest(code))
        .map_err(|e| format!("No se pudo guardar el código de forma segura: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn gist_verify_admin_code(code: String) -> Result<bool, String> {
    verify_admin_code(&code)?;
    Ok(true)
}

#[tauri::command]
pub async fn gist_get_launcher_whitelist() -> Result<LauncherWhitelist, String> {
    load_public_launcher_whitelist().await
}

async fn load_public_launcher_whitelist() -> Result<LauncherWhitelist, String> {
    let client = http_client()?;
    let response = client
        .get(format!("{GITHUB_API}/gists/{GIST_ID}"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("No se pudo consultar la whitelist de instancias: {e}"))?;
    let gist: Value = checked(response)
        .await?
        .json()
        .await
        .map_err(|e| format!("GitHub devolvió una whitelist inválida: {e}"))?;
    let Some(file) = gist.pointer(&format!("/files/{LAUNCHER_WHITELIST_FILE}")) else {
        return Ok(LauncherWhitelist::default());
    };
    if file.get("truncated").and_then(Value::as_bool) == Some(true) {
        return Err("El archivo de whitelist remoto supera el tamaño permitido.".into());
    }
    let content = file
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "GitHub no devolvió el contenido de la whitelist.".to_string())?;
    let config: LauncherWhitelist = serde_json::from_str(content)
        .map_err(|e| format!("La whitelist publicada tiene un formato inválido: {e}"))?;
    validate_launcher_whitelist(&config)?;
    Ok(config)
}

pub(crate) async fn launcher_user_can_view_instances(
    profile_uuid: &str,
    username: &str,
) -> Result<bool, String> {
    let whitelist = load_public_launcher_whitelist().await?;
    if !whitelist.enabled {
        return Ok(true);
    }
    let normalized_uuid = profile_uuid.replace('-', "").to_ascii_lowercase();
    let username = username.trim();
    Ok(whitelist.allowed.iter().any(|entry| {
        let entry = entry.trim();
        entry.eq_ignore_ascii_case(username)
            || entry
                .replace('-', "")
                .eq_ignore_ascii_case(&normalized_uuid)
    }))
}

#[tauri::command]
pub async fn gist_publish_launcher_whitelist(
    admin_code: String,
    enabled: bool,
    allowed: Vec<String>,
) -> Result<GistEditorAccess, String> {
    verify_admin_code(&admin_code)?;
    let config = LauncherWhitelist { enabled, allowed };
    validate_launcher_whitelist(&config)?;
    let token = saved_token()?
        .ok_or_else(|| "Conecta primero la cuenta administradora de GitHub.".to_string())?;
    let client = http_client()?;
    let (login, _) = verify_owner(&client, &token).await?;
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("No se pudo preparar la whitelist: {e}"))?;
    let response = client
        .patch(format!("{GITHUB_API}/gists/{GIST_ID}"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&serde_json::json!({"files": { (LAUNCHER_WHITELIST_FILE): {"content": content} }}))
        .send()
        .await
        .map_err(|e| format!("No se pudo publicar la whitelist: {e}"))?;
    checked(response).await?;
    Ok(GistEditorAccess {
        login,
        gist_url: format!("https://gist.github.com/{GIST_OWNER}/{GIST_ID}"),
    })
}

#[tauri::command]
pub fn gist_disconnect() -> Result<bool, String> {
    match token_entry()?.delete_password() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(true),
        Err(error) => Err(format!(
            "No se pudo eliminar el token del almacén seguro: {error}"
        )),
    }
}

fn validate_events(content: &str) -> Result<(), String> {
    let events: Vec<Value> =
        serde_json::from_str(content).map_err(|e| format!("El archivo no es JSON válido: {e}"))?;
    for (index, event) in events.iter().enumerate() {
        let number = index + 1;
        let object = event
            .as_object()
            .ok_or_else(|| format!("El evento {number} debe ser un objeto JSON."))?;
        let id = object.get("id").and_then(Value::as_str).unwrap_or_default();
        if id.is_empty()
            || id.len() > 64
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(format!(
                "El evento {number} necesita un id con letras, números, guion o guion bajo (máximo 64 caracteres)."
            ));
        }
        if object
            .get("nombre_evento")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .is_empty()
        {
            return Err(format!("El evento {number} necesita nombre_evento."));
        }
        for field in ["url_modpack", "url_loader"] {
            if let Some(url) = object.get(field).and_then(Value::as_str) {
                if !url.is_empty() && !url.starts_with("https://") {
                    return Err(format!(
                        "La propiedad {field} del evento {id} debe usar HTTPS."
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_launcher_whitelist(config: &LauncherWhitelist) -> Result<(), String> {
    if config.allowed.len() > 2000 {
        return Err("La whitelist no puede contener más de 2000 usuarios.".into());
    }
    for (index, entry) in config.allowed.iter().enumerate() {
        let value = entry.trim();
        if value.is_empty()
            || value.len() > 64
            || !value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        {
            return Err(format!(
                "La entrada {} de la whitelist no es válida. Usa UUID o username sin espacios ni caracteres especiales.",
                index + 1
            ));
        }
    }
    Ok(())
}
