use crate::types::*;
use base64::Engine as _;
use keyring::Entry;
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

// ─────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────

const KEYRING_SERVICE: &str = "migajas-launcher";

const MSA_CLIENT_ID: &str = "00000000402b5328";
const MSA_SCOPE: &str = "service::user.auth.xboxlive.com::MBI_SSL";
const MSA_REDIRECT_URI: &str = "https://login.live.com/oauth20_desktop.srf";

const MS_LOGIN_LABEL: &str = "ms-login";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(120);

const URL_AUTHORIZE: &str = "https://login.live.com/oauth20_authorize.srf\
    ?client_id=00000000402b5328\
    &response_type=code\
    &redirect_uri=https%3A%2F%2Flogin.live.com%2Foauth20_desktop.srf\
    &scope=service%3A%3Auser.auth.xboxlive.com%3A%3AMBI_SSL\
    &prompt=login";

const URL_TOKEN: &str = "https://login.live.com/oauth20_token.srf";
const URL_XBL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const URL_XSTS: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const URL_MC_LOGIN: &str = "https://api.minecraftservices.com/authentication/login_with_xbox";
const URL_MC_PROFILE: &str = "https://api.minecraftservices.com/minecraft/profile";
const URL_MOJANG_SESSION: &str = "https://sessionserver.mojang.com/session/minecraft/profile";
const XSTS_RP_MINECRAFT: &str = "rp://api.minecraftservices.com/";

// ─────────────────────────────────────────────────────────────────────────
// Tipos internos del flujo MSA / Xbox
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct MsaTokenResponse {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
struct XboxAuthRequest {
    properties: XboxAuthProperties,
    relying_party: String,
    token_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
struct XboxAuthProperties {
    auth_method: String,
    site_name: String,
    rps_ticket: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
struct XstsRequest {
    properties: XstsProperties,
    relying_party: String,
    token_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "PascalCase")]
struct XstsProperties {
    sandbox_id: String,
    user_tokens: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct XboxTokenResponse {
    token: String,
    display_claims: XboxDisplayClaims,
}

#[derive(Debug, Deserialize)]
struct XboxDisplayClaims {
    xui: Vec<XboxXui>,
}

#[derive(Debug, Deserialize)]
struct XboxXui {
    uhs: String,
}

#[derive(Debug, Deserialize)]
struct XstsErrorBody {
    #[serde(default, rename = "XErr")]
    x_err: Option<u64>,
    #[serde(default, rename = "Message")]
    message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct McLoginRequest {
    identity_token: String,
}

#[derive(Debug, Deserialize)]
struct McLoginResponse {
    access_token: String,
}

#[derive(Debug, Deserialize)]
struct McProfileResponse {
    id: String,
    name: String,
    #[serde(default)]
    skins: Vec<McSkin>,
}

#[derive(Debug, Deserialize)]
struct McSkin {
    #[serde(default)]
    url: String,
    #[serde(default)]
    state: String,
}

struct MsaTokens {
    access_token: String,
    refresh_token: String,
}

struct MinecraftSession {
    profile: MinecraftProfile,
    refresh_token: String,
}

// ─────────────────────────────────────────────────────────────────────────
// Persistencia en disco: profiles.json
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProfilesFile {
    #[serde(default)]
    selected_profile: Option<String>,
    #[serde(default)]
    profiles: HashMap<String, StoredProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProfile {
    uuid: String,
    username: String,
    account_type: AccountType,
    #[serde(default)]
    skin_url: String,
    #[serde(default)]
    avatar_url: String,
    last_used: u64,
}

fn profiles_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join("profiles.json"))
        .unwrap_or_else(|_| PathBuf::from("profiles.json"))
}

fn skins_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join("skins"))
        .unwrap_or_else(|_| PathBuf::from("skins"))
}

fn avatars_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join("avatars"))
        .unwrap_or_else(|_| PathBuf::from("avatars"))
}

async fn load_profiles_file(app: &AppHandle) -> ProfilesFile {
    let path = profiles_path(app);
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => ProfilesFile::default(),
    }
}

pub(crate) async fn saved_profile_username(app: &AppHandle, uuid: &str) -> Option<String> {
    let file = load_profiles_file(app).await;
    let normalized = uuid.replace('-', "").to_ascii_lowercase();
    file.profiles
        .values()
        .find(|profile| profile.uuid.replace('-', "").to_ascii_lowercase() == normalized)
        .map(|profile| profile.username.clone())
}

async fn save_profiles_file(app: &AppHandle, file: &ProfilesFile) -> Result<(), String> {
    let path = profiles_path(app);
    if let Some(parent) = path.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let bytes = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| format!("No se pudo escribir profiles.json: {e}"))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| format!("No se pudo renombrar profiles.json: {e}"))?;
    Ok(())
}

async fn upsert_profile(app: &AppHandle, profile: &MinecraftProfile) -> Result<(), String> {
    let mut file = load_profiles_file(app).await;
    file.profiles.insert(
        profile.uuid.clone(),
        StoredProfile {
            uuid: profile.uuid.clone(),
            username: profile.username.clone(),
            account_type: profile.account_type.clone(),
            skin_url: profile.skin_url.clone(),
            avatar_url: profile.avatar_url.clone(),
            last_used: profile.last_used,
        },
    );
    file.selected_profile = Some(profile.uuid.clone());
    save_profiles_file(app, &file).await
}

async fn remove_profile(app: &AppHandle, uuid: &str) -> Result<(), String> {
    let mut file = load_profiles_file(app).await;
    file.profiles.remove(uuid);
    if file.selected_profile.as_deref() == Some(uuid) {
        file.selected_profile = None;
    }
    save_profiles_file(app, &file).await
}

// ─────────────────────────────────────────────────────────────────────────
// Keyring (servicio "migajas-launcher" / clave "account_{uuid}")
// ─────────────────────────────────────────────────────────────────────────

fn keyring_entry(uuid: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, &format!("account_{uuid}"))
        .map_err(|e| format!("Error al acceder al Keyring: {e}"))
}

fn save_refresh_token(uuid: &str, refresh_token: &str) -> Result<(), String> {
    keyring_entry(uuid)?
        .set_password(refresh_token)
        .map_err(|e| e.to_string())
}

fn load_refresh_token(uuid: &str) -> Result<String, String> {
    keyring_entry(uuid)?
        .get_password()
        .map_err(|e| e.to_string())
}

/// Borra la credencial. Aislado para sobrevivir a renames entre versiones
/// menores de `keyring` (`delete_password` ↔ `delete_credential`).
fn delete_refresh_token(uuid: &str) -> bool {
    match keyring_entry(uuid) {
        Ok(entry) => entry.delete_password().is_ok(),
        Err(_) => false,
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Utilidades de imagen y caché
// ─────────────────────────────────────────────────────────────────────────

async fn read_as_data_url(path: &Path) -> Result<String, std::io::Error> {
    let bytes = tokio::fs::read(path).await?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{encoded}"))
}

/// Extrae los bytes PNG de un Data URL `data:image/png;base64,...`.
fn data_url_to_bytes(data_url: &str) -> Option<Vec<u8>> {
    let (_, b64) = data_url.split_once(',')?;
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

async fn download_file_once(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
) -> Result<(), String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("HTTP error: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| format!("read body: {e}"))?;

    // Validación de firma PNG para no cachear HTML/JSON de error
    if bytes.len() < 8 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("La respuesta no es un PNG válido".into());
    }

    if let Some(parent) = dest.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    tokio::fs::write(dest, &bytes)
        .await
        .map_err(|e| format!("write file: {e}"))?;
    Ok(())
}

async fn download_file_with_retry(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    attempts: u32,
) -> Result<(), String> {
    let mut last_err = String::new();
    for i in 0..attempts {
        match download_file_once(client, url, dest).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e;
                if i + 1 < attempts {
                    let delay = 250u64 * 2u64.pow(i); // 250ms, 500ms, 1000ms…
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
            }
        }
    }
    Err(last_err)
}

/// Recorta la cabeza (cara + overlay) de una skin PNG y la escala a 64×64.
/// Soporta skins modernas (64×64), legacy (64×32) y HD (128×128, 256×256…).
fn crop_head_from_skin(skin_bytes: &[u8]) -> Option<Vec<u8>> {
    use image::{GenericImageView, ImageFormat};
    use std::io::Cursor;

    let img = image::load_from_memory_with_format(skin_bytes, ImageFormat::Png).ok()?;
    let (w, h) = img.dimensions();

    if w < 64 || h < 32 || w % 64 != 0 || h % 32 != 0 {
        return None;
    }
    let scale = w / 64;

    let mut head = img
        .crop_imm(8 * scale, 8 * scale, 8 * scale, 8 * scale)
        .to_rgba8();

    // Overlay del sombrero (solo skins modernas 64×64·s)
    if h >= 64 * scale {
        let overlay = img
            .crop_imm(40 * scale, 8 * scale, 8 * scale, 8 * scale)
            .to_rgba8();

        for (x, y, px) in overlay.enumerate_pixels() {
            let a = px[3] as u32;
            if a == 0 {
                continue;
            }
            let base = head.get_pixel_mut(x, y);
            let inv = 255 - a;
            base[0] = ((px[0] as u32 * a + base[0] as u32 * inv) / 255) as u8;
            base[1] = ((px[1] as u32 * a + base[1] as u32 * inv) / 255) as u8;
            base[2] = ((px[2] as u32 * a + base[2] as u32 * inv) / 255) as u8;
            base[3] = 255;
        }
    }

    let scaled = image::imageops::resize(&head, 64, 64, image::imageops::FilterType::Nearest);

    let mut out = Vec::new();
    scaled
        .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .ok()?;
    Some(out)
}

/// Consulta `sessionserver.mojang.com` y extrae `textures.SKIN.url`
/// del campo `value` (Base64) de la propiedad `"textures"`.
async fn lookup_skin_url(client: &reqwest::Client, uuid_con_guiones: &str) -> Option<String> {
    let uuid_sin_guiones = uuid_con_guiones.replace('-', "");
    let url = format!("{URL_MOJANG_SESSION}/{}", uuid_sin_guiones);

    let resp = client.get(&url).send().await.ok()?;
    if resp.status().as_u16() != 200 {
        return None;
    }

    let body: serde_json::Value = resp.json().await.ok()?;
    let properties = body.get("properties")?.as_array()?;

    for prop in properties {
        if prop.get("name").and_then(|v| v.as_str()) != Some("textures") {
            continue;
        }
        let value_b64 = prop.get("value")?.as_str()?;
        let decoded_bytes = base64::engine::general_purpose::STANDARD
            .decode(value_b64)
            .ok()?;
        let decoded: serde_json::Value = serde_json::from_slice(&decoded_bytes).ok()?;

        return decoded
            .get("textures")?
            .get("SKIN")?
            .get("url")?
            .as_str()
            .map(|s| s.to_string());
    }
    None
}

/// Resuelve la skin oficial de un jugador vía la API de sesiones de Mojang
/// y la devuelve como Data URL Base64 (`data:image/png;base64,...`).
pub async fn obtener_skin_oficial(
    client: &reqwest::Client,
    uuid_con_guiones: &str,
) -> Option<String> {
    let skin_url = lookup_skin_url(client, uuid_con_guiones).await?;

    let resp = client.get(&skin_url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;

    if bytes.len() < 8 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }

    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:image/png;base64,{encoded}"))
}

/// Descarga (o reutiliza caché de) la skin oficial. Sin terceros.
/// Orden: caché local → URL directa de Microsoft → API oficial de Mojang.
async fn fetch_and_cache_skin(
    app: &AppHandle,
    client: &reqwest::Client,
    uuid: &str,
    remote_skin_url: Option<&str>,
) -> String {
    let dir = skins_dir(app);
    let _ = tokio::fs::create_dir_all(&dir).await;
    let path = dir.join(format!("{uuid}.png"));

    // 1) Caché
    if path.exists() {
        if let Ok(data_url) = read_as_data_url(&path).await {
            return data_url;
        }
        let _ = tokio::fs::remove_file(&path).await;
    }

    // 2) URL directa desde Microsoft (viene en la respuesta de login)
    if let Some(url) = remote_skin_url.filter(|u| !u.is_empty()) {
        if download_file_with_retry(client, url, &path, 3)
            .await
            .is_ok()
        {
            if let Ok(data_url) = read_as_data_url(&path).await {
                return data_url;
            }
        }
    }

    // 3) API oficial de Mojang
    if let Some(data_url) = obtener_skin_oficial(client, uuid).await {
        if let Some(bytes) = data_url_to_bytes(&data_url) {
            let _ = tokio::fs::write(&path, &bytes).await;
        }
        return data_url;
    }

    // 4) Sin skin disponible → vacío (frontend muestra placeholder)
    String::new()
}

/// Lee la skin cacheada (o devuelve `fallback` si no existe). Sin red.
async fn get_cached_skin(app: &AppHandle, uuid: &str, fallback: &str) -> String {
    let path = skins_dir(app).join(format!("{uuid}.png"));
    if path.exists() {
        if let Ok(data_url) = read_as_data_url(&path).await {
            return data_url;
        }
    }
    fallback.to_string()
}

/// Devuelve el avatar como Data URL. **Sin red**: recorta la cabeza
/// desde la skin cacheada. Si no hay skin disponible, devuelve `""`.
async fn get_avatar(app: &AppHandle, uuid: &str) -> String {
    let avatar_path = avatars_dir(app).join(format!("{uuid}.png"));

    // 1) Caché de avatar
    if avatar_path.exists() {
        if let Ok(data_url) = read_as_data_url(&avatar_path).await {
            return data_url;
        }
        let _ = tokio::fs::remove_file(&avatar_path).await;
    }

    // 2) Recortar desde la skin cacheada
    let skin_path = skins_dir(app).join(format!("{uuid}.png"));
    if let Ok(skin_bytes) = tokio::fs::read(&skin_path).await {
        if let Some(head_bytes) = crop_head_from_skin(&skin_bytes) {
            let _ = tokio::fs::create_dir_all(avatars_dir(app)).await;
            let _ = tokio::fs::write(&avatar_path, &head_bytes).await;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&head_bytes);
            return format!("data:image/png;base64,{encoded}");
        }
    }

    String::new()
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers de utilidades
// ─────────────────────────────────────────────────────────────────────────

struct LoginWindowGuard {
    app: AppHandle,
}

impl Drop for LoginWindowGuard {
    fn drop(&mut self) {
        close_ms_login_window(&self.app);
    }
}

fn auth_fail(code: AuthErrorCode, message: impl Into<String>) -> AuthResponse {
    AuthResponse {
        success: false,
        profile: None,
        error: Some(AuthError {
            code,
            message: message.into(),
        }),
    }
}

fn auth_ok(profile: MinecraftProfile) -> AuthResponse {
    AuthResponse {
        success: true,
        profile: Some(profile),
        error: None,
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn http_client() -> Result<reqwest::Client, AuthResponse> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("MigajasLauncher/1.1.5")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| {
            auth_fail(
                AuthErrorCode::NetworkError,
                format!("No se pudo crear el cliente HTTP: {e}"),
            )
        })
}

fn dashed_uuid(raw: &str) -> String {
    let hex: String = raw.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() == 32 {
        format!(
            "{}-{}-{}-{}-{}",
            &hex[0..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..32]
        )
    } else if !raw.is_empty() {
        raw.to_string()
    } else {
        Uuid::nil().to_string()
    }
}

/// Genera el UUID v3 offline para un username. Pura, sin side-effects.
/// Devuelve `Err` si el username no cumple las reglas de Mojang.
/// Expuesta `pub` para poder testearla sin necesidad de `AppHandle`.
pub fn offline_uuid_for(username: &str) -> Result<String, &'static str> {
    if username.is_empty()
        || username.len() > 16
        || !username.chars().all(|c| c.is_alphanumeric() || c == '_')
    {
        return Err(
            "Nombre de usuario inválido. Debe tener entre 1 y 16 caracteres alfanuméricos o guiones bajos.",
        );
    }
    let offline_str = format!("OfflinePlayer:{username}");
    let mut hasher = Md5::new();
    hasher.update(offline_str.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(digest.as_slice());
    bytes[6] = (bytes[6] & 0x0f) | 0x30; // versión 3 (MD5)
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
    Ok(Uuid::from_bytes(bytes).to_string())
}

fn percent_decode(s: &str) -> Result<String, ()> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|_| ())?;
                out.push(u8::from_str_radix(hex, 16).map_err(|_| ())?);
                i += 3;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

fn urlencoding_decode(s: &str) -> String {
    let plus = s.replace('+', " ");
    percent_decode(&plus).unwrap_or(plus)
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        if parts.next() == Some(key) {
            return Some(urlencoding_decode(parts.next().unwrap_or("")));
        }
    }
    None
}

fn map_xsts_error(xerr: u64) -> AuthResponse {
    match xerr {
        2148916233 => auth_fail(
            AuthErrorCode::NoMinecraftLicense,
            "Esta cuenta de Microsoft no tiene un perfil de Xbox. Créalo en xbox.com e inténtalo de nuevo.",
        ),
        2148916235 => auth_fail(
            AuthErrorCode::NetworkError,
            "Xbox Live no está disponible en el país de esta cuenta.",
        ),
        2148916238 => auth_fail(
            AuthErrorCode::AuthCanceled,
            "Esta cuenta es de un menor y necesita que un adulto la añada a una familia de Xbox.",
        ),
        other => auth_fail(
            AuthErrorCode::NetworkError,
            format!("Xbox rechazó la autorización (XErr {other})."),
        ),
    }
}

fn rps_ticket(access_token: &str) -> String {
    if access_token.starts_with("d=") || access_token.starts_with("t=") {
        access_token.to_string()
    } else {
        format!("d={access_token}")
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Intercepción de redirect URI vía on_navigation
// ─────────────────────────────────────────────────────────────────────────

fn close_ms_login_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MS_LOGIN_LABEL) {
        let _ = window.close();
    }
}

fn extract_oauth_result(url: &reqwest::Url) -> Option<Result<String, AuthResponse>> {
    let query = url.query()?;

    if let Some(err) = query_param(query, "error") {
        let description = query_param(query, "error_description")
            .unwrap_or_else(|| format!("Microsoft devolvió un error ({err})."));
        let code = if err == "access_denied" {
            AuthErrorCode::AuthCanceled
        } else {
            AuthErrorCode::NetworkError
        };
        return Some(Err(auth_fail(code, description)));
    }

    query_param(query, "code").filter(|c| !c.is_empty()).map(Ok)
}

async fn wait_for_ms_login_closed(app: AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if app.get_webview_window(MS_LOGIN_LABEL).is_none() {
            break;
        }
    }
}

async fn obtain_authorization_code(app: &AppHandle) -> Result<String, AuthResponse> {
    let parsed: reqwest::Url = URL_AUTHORIZE.parse().map_err(|e| {
        auth_fail(
            AuthErrorCode::NetworkError,
            format!("URL de login inválida: {e}"),
        )
    })?;

    let (code_tx, code_rx) = tokio::sync::oneshot::channel::<Result<String, AuthResponse>>();
    let code_tx = Arc::new(StdMutex::new(Some(code_tx)));
    let (build_tx, build_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

    let handle = app.clone();
    let nav_tx = code_tx;

    handle
        .clone()
        .run_on_main_thread(move || {
            if let Some(existing) = handle.get_webview_window(MS_LOGIN_LABEL) {
                let _ = existing.close();
            }

            let result =
                WebviewWindowBuilder::new(&handle, MS_LOGIN_LABEL, WebviewUrl::External(parsed))
                    .title("Iniciar sesión con Microsoft")
                    .inner_size(500.0, 650.0)
                    .center()
                    .focused(true)
                    .visible(true)
                    .resizable(true)
                    .on_navigation(move |url| {
                        if !url.as_str().starts_with(MSA_REDIRECT_URI) {
                            return true;
                        }
                        let outcome = extract_oauth_result(url).unwrap_or_else(|| {
                            Err(auth_fail(
                                AuthErrorCode::NetworkError,
                                "Microsoft redirigió sin código de autorización.",
                            ))
                        });
                        if let Ok(mut guard) = nav_tx.lock() {
                            if let Some(sender) = guard.take() {
                                let _ = sender.send(outcome);
                            }
                        }
                        false
                    })
                    .build();

            let _ = build_tx.send(result.map(|_| ()).map_err(|e| e.to_string()));
        })
        .map_err(|e| {
            auth_fail(
                AuthErrorCode::NetworkError,
                format!("No se pudo abrir la ventana de login: {e}"),
            )
        })?;

    build_rx
        .await
        .map_err(|e| {
            auth_fail(
                AuthErrorCode::NetworkError,
                format!("La ventana de login se cerró sin resultado: {e}"),
            )
        })?
        .map_err(|e| {
            auth_fail(
                AuthErrorCode::NetworkError,
                format!("No se pudo construir la ventana de login: {e}"),
            )
        })?;

    let _guard = LoginWindowGuard { app: app.clone() };

    tokio::select! {
        biased;
        result = code_rx => match result {
            Ok(Ok(code)) => Ok(code),
            Ok(Err(resp)) => Err(resp),
            Err(_) => Err(auth_fail(
                AuthErrorCode::AuthCanceled,
                "El flujo de autenticación fue interrumpido.",
            )),
        },
        _ = tokio::time::sleep(LOGIN_TIMEOUT) => Err(auth_fail(
            AuthErrorCode::AuthCanceled,
            "El inicio de sesión expiró (120 s) sin completar la autorización.",
        )),
        _ = wait_for_ms_login_closed(app.clone()) => Err(auth_fail(
            AuthErrorCode::AuthCanceled,
            "La ventana de inicio de sesión se cerró antes de completar la autorización.",
        )),
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Cadena MSA → XBL → XSTS → Minecraft
// ─────────────────────────────────────────────────────────────────────────

async fn parse_msa_token_response(
    resp: reqwest::Response,
    fallback: &str,
) -> Result<MsaTokens, AuthResponse> {
    let body = resp.text().await.map_err(|e| {
        auth_fail(
            AuthErrorCode::NetworkError,
            format!("Respuesta inválida de Microsoft: {e}"),
        )
    })?;

    let parsed: MsaTokenResponse = serde_json::from_str(&body)
        .map_err(|_| auth_fail(AuthErrorCode::TokenExpired, fallback))?;

    if let Some(err) = parsed.error {
        let description = parsed.error_description.unwrap_or(err.clone());
        let code = if err == "invalid_grant" {
            AuthErrorCode::TokenExpired
        } else {
            AuthErrorCode::NetworkError
        };
        return Err(auth_fail(code, description));
    }

    let access_token = parsed.access_token.ok_or_else(|| {
        auth_fail(
            AuthErrorCode::NetworkError,
            "Microsoft no devolvió un access_token.",
        )
    })?;
    let refresh_token = parsed.refresh_token.unwrap_or_default();
    if refresh_token.is_empty() && fallback.contains("canjear") {
        return Err(auth_fail(
            AuthErrorCode::NetworkError,
            "Microsoft no devolvió un refresh_token.",
        ));
    }
    Ok(MsaTokens {
        access_token,
        refresh_token,
    })
}

async fn exchange_auth_code(
    client: &reqwest::Client,
    code: &str,
) -> Result<MsaTokens, AuthResponse> {
    let resp = client
        .post(URL_TOKEN)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", MSA_CLIENT_ID),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", MSA_REDIRECT_URI),
            ("scope", MSA_SCOPE),
        ])
        .send()
        .await
        .map_err(|e| {
            auth_fail(
                AuthErrorCode::NetworkError,
                format!("Error al canjear el código de Microsoft: {e}"),
            )
        })?;

    parse_msa_token_response(
        resp,
        "No se pudo canjear el código de autorización de Microsoft.",
    )
    .await
}

async fn refresh_msa_token(
    client: &reqwest::Client,
    refresh_token: &str,
) -> Result<MsaTokens, AuthResponse> {
    let resp = client
        .post(URL_TOKEN)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", MSA_CLIENT_ID),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("scope", MSA_SCOPE),
        ])
        .send()
        .await
        .map_err(|e| {
            auth_fail(
                AuthErrorCode::NetworkError,
                format!("Error al renovar el token de Microsoft: {e}"),
            )
        })?;

    let tokens =
        parse_msa_token_response(resp, "No se pudo renovar la sesión de Microsoft.").await?;
    Ok(MsaTokens {
        access_token: tokens.access_token,
        refresh_token: if tokens.refresh_token.is_empty() {
            refresh_token.to_string()
        } else {
            tokens.refresh_token
        },
    })
}

async fn xbox_authenticate_with_ticket(
    client: &reqwest::Client,
    ticket: String,
) -> Result<Result<(String, String), (reqwest::StatusCode, String)>, AuthResponse> {
    let request = XboxAuthRequest {
        properties: XboxAuthProperties {
            auth_method: "RPS".into(),
            site_name: "user.auth.xboxlive.com".into(),
            rps_ticket: ticket,
        },
        relying_party: "http://auth.xboxlive.com".into(),
        token_type: "JWT".into(),
    };

    let resp = client
        .post(URL_XBL)
        .header("Accept", "application/json")
        .header("x-xbl-contract-version", "1")
        .json(&request)
        .send()
        .await
        .map_err(|e| {
            auth_fail(
                AuthErrorCode::NetworkError,
                format!("Error al autenticar con Xbox Live: {e}"),
            )
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        auth_fail(
            AuthErrorCode::NetworkError,
            format!("Respuesta inválida de Xbox Live: {e}"),
        )
    })?;

    if status.is_success() {
        let parsed: XboxTokenResponse = serde_json::from_str(&body).map_err(|e| {
            auth_fail(
                AuthErrorCode::NetworkError,
                format!("No se pudo leer el token de Xbox Live: {e}"),
            )
        })?;
        let uhs = parsed
            .display_claims
            .xui
            .first()
            .map(|x| x.uhs.clone())
            .ok_or_else(|| {
                auth_fail(
                    AuthErrorCode::NetworkError,
                    "Xbox Live no devolvió el user hash (uhs).",
                )
            })?;
        return Ok(Ok((parsed.token, uhs)));
    }
    Ok(Err((status, body)))
}

async fn xbox_authenticate(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<(String, String), AuthResponse> {
    let prefixed = rps_ticket(access_token);
    match xbox_authenticate_with_ticket(client, prefixed).await? {
        Ok(ok) => Ok(ok),
        Err((status, body)) => {
            if status.as_u16() == 400 && !access_token.starts_with("d=") {
                if let Ok(Ok(ok)) =
                    xbox_authenticate_with_ticket(client, access_token.to_string()).await
                {
                    return Ok(ok);
                }
            }
            if let Ok(err) = serde_json::from_str::<XstsErrorBody>(&body) {
                if let Some(xerr) = err.x_err {
                    return Err(map_xsts_error(xerr));
                }
            }
            Err(auth_fail(
                AuthErrorCode::NetworkError,
                format!("Xbox Live rechazó la autenticación (HTTP {status})."),
            ))
        }
    }
}

async fn xsts_authorize(client: &reqwest::Client, xbl_token: &str) -> Result<String, AuthResponse> {
    let request = XstsRequest {
        properties: XstsProperties {
            sandbox_id: "RETAIL".into(),
            user_tokens: vec![xbl_token.to_string()],
        },
        relying_party: XSTS_RP_MINECRAFT.into(),
        token_type: "JWT".into(),
    };

    let resp = client
        .post(URL_XSTS)
        .header("Accept", "application/json")
        .header("x-xbl-contract-version", "1")
        .json(&request)
        .send()
        .await
        .map_err(|e| {
            auth_fail(
                AuthErrorCode::NetworkError,
                format!("Error al autorizar XSTS: {e}"),
            )
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        auth_fail(
            AuthErrorCode::NetworkError,
            format!("Respuesta inválida de XSTS: {e}"),
        )
    })?;

    if !status.is_success() {
        if let Ok(err) = serde_json::from_str::<XstsErrorBody>(&body) {
            if let Some(xerr) = err.x_err {
                return Err(map_xsts_error(xerr));
            }
            if let Some(msg) = err.message.filter(|m| !m.is_empty()) {
                return Err(auth_fail(AuthErrorCode::NetworkError, msg));
            }
        }
        return Err(auth_fail(
            AuthErrorCode::NetworkError,
            format!("XSTS rechazó la autorización (HTTP {status})."),
        ));
    }

    let parsed: XboxTokenResponse = serde_json::from_str(&body).map_err(|e| {
        auth_fail(
            AuthErrorCode::NetworkError,
            format!("No se pudo leer el token XSTS: {e}"),
        )
    })?;
    Ok(parsed.token)
}

async fn minecraft_login_and_profile(
    client: &reqwest::Client,
    app: &AppHandle,
    uhs: &str,
    xsts_token: &str,
) -> Result<MinecraftProfile, AuthResponse> {
    let identity_token = format!("XBL3.0 x={uhs};{xsts_token}");
    let resp = client
        .post(URL_MC_LOGIN)
        .json(&McLoginRequest { identity_token })
        .send()
        .await
        .map_err(|e| {
            auth_fail(
                AuthErrorCode::NetworkError,
                format!("Error al iniciar sesión en Minecraft: {e}"),
            )
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        auth_fail(
            AuthErrorCode::NetworkError,
            format!("Respuesta inválida de Minecraft: {e}"),
        )
    })?;

    if !status.is_success() {
        return Err(auth_fail(
            AuthErrorCode::NetworkError,
            format!("Minecraft rechazó el login con Xbox (HTTP {status})."),
        ));
    }

    let login: McLoginResponse = serde_json::from_str(&body).map_err(|e| {
        auth_fail(
            AuthErrorCode::NetworkError,
            format!("No se pudo leer el token de Minecraft: {e}"),
        )
    })?;

    let profile_resp = client
        .get(URL_MC_PROFILE)
        .bearer_auth(&login.access_token)
        .send()
        .await
        .map_err(|e| {
            auth_fail(
                AuthErrorCode::NetworkError,
                format!("Error al obtener el perfil de Minecraft: {e}"),
            )
        })?;

    if profile_resp.status().as_u16() == 404 {
        return Err(auth_fail(
            AuthErrorCode::NoMinecraftLicense,
            "Esta cuenta de Microsoft no tiene Minecraft Java Edition.",
        ));
    }

    if !profile_resp.status().is_success() {
        return Err(auth_fail(
            AuthErrorCode::NetworkError,
            format!(
                "No se pudo leer el perfil de Minecraft (HTTP {}).",
                profile_resp.status()
            ),
        ));
    }

    let mc_profile: McProfileResponse = profile_resp.json().await.map_err(|e| {
        auth_fail(
            AuthErrorCode::NetworkError,
            format!("Perfil de Minecraft inválido: {e}"),
        )
    })?;

    let uuid = dashed_uuid(&mc_profile.id);

    let remote_skin = mc_profile
        .skins
        .iter()
        .find(|s| s.state.eq_ignore_ascii_case("ACTIVE") && !s.url.is_empty())
        .or_else(|| mc_profile.skins.first())
        .map(|s| s.url.clone());

    // Descarga/cachea skin (Microsoft → Mojang), y recorta el avatar localmente.
    let skin_url = fetch_and_cache_skin(app, client, &uuid, remote_skin.as_deref()).await;
    let avatar_url = get_avatar(app, &uuid).await;

    Ok(MinecraftProfile {
        uuid,
        username: mc_profile.name,
        account_type: AccountType::Microsoft,
        access_token: Some(login.access_token),
        skin_url,
        avatar_url,
        last_used: now_secs(),
    })
}

async fn complete_minecraft_session(
    client: &reqwest::Client,
    app: &AppHandle,
    msa: MsaTokens,
) -> Result<MinecraftSession, AuthResponse> {
    let (xbl_token, uhs) = xbox_authenticate(client, &msa.access_token).await?;
    let xsts_token = xsts_authorize(client, &xbl_token).await?;
    let profile = minecraft_login_and_profile(client, app, &uhs, &xsts_token).await?;
    Ok(MinecraftSession {
        profile,
        refresh_token: msa.refresh_token,
    })
}

async fn persist_session(app: &AppHandle, session: &MinecraftSession) -> Result<(), String> {
    if matches!(session.profile.account_type, AccountType::Microsoft) {
        save_refresh_token(&session.profile.uuid, &session.refresh_token)?;
    }
    upsert_profile(app, &session.profile).await
}

// ─────────────────────────────────────────────────────────────────────────
// Comandos IPC
// ─────────────────────────────────────────────────────────────────────────

/// Comando: auth_login_microsoft
#[tauri::command]
pub async fn auth_login_microsoft(app: AppHandle) -> Result<AuthResponse, String> {
    let client = match http_client() {
        Ok(c) => c,
        Err(resp) => return Ok(resp),
    };

    let code = match obtain_authorization_code(&app).await {
        Ok(c) => c,
        Err(resp) => return Ok(resp),
    };

    let msa = match exchange_auth_code(&client, &code).await {
        Ok(t) => t,
        Err(resp) => return Ok(resp),
    };

    let session = match complete_minecraft_session(&client, &app, msa).await {
        Ok(s) => s,
        Err(resp) => return Ok(resp),
    };

    if let Err(e) = persist_session(&app, &session).await {
        log::warn!("No se pudo persistir la sesión: {e}");
    }

    Ok(auth_ok(session.profile))
}

/// Comando: auth_restore_session
#[tauri::command]
pub async fn auth_restore_session(
    app: AppHandle,
    uuid: Option<String>,
) -> Result<AuthResponse, String> {
    let file = load_profiles_file(&app).await;

    let target_uuid = uuid
        .filter(|u| !u.is_empty())
        .or_else(|| file.selected_profile.clone());

    let target_uuid = match target_uuid {
        Some(u) => u,
        None => {
            return Ok(auth_fail(
                AuthErrorCode::KeyringError,
                "No hay sesiones guardadas para restaurar.",
            ));
        }
    };

    let stored = match file.profiles.get(&target_uuid) {
        Some(s) => s.clone(),
        None => {
            return Ok(auth_fail(
                AuthErrorCode::KeyringError,
                "Perfil no encontrado en profiles.json.",
            ));
        }
    };

    match stored.account_type {
        AccountType::Offline => {
            let skin_url = get_cached_skin(&app, &stored.uuid, &stored.skin_url).await;
            let avatar_url = get_avatar(&app, &stored.uuid).await;
            let profile = MinecraftProfile {
                uuid: stored.uuid.clone(),
                username: stored.username.clone(),
                account_type: AccountType::Offline,
                access_token: None,
                skin_url,
                avatar_url,
                last_used: now_secs(),
            };
            let _ = upsert_profile(&app, &profile).await;
            Ok(auth_ok(profile))
        }
        AccountType::Microsoft => {
            let refresh_token = match load_refresh_token(&target_uuid) {
                Ok(t) => t,
                Err(_) => {
                    return Ok(auth_fail(
                        AuthErrorCode::TokenExpired,
                        "No se encontró token válido en el Keyring.",
                    ));
                }
            };

            let client = match http_client() {
                Ok(c) => c,
                Err(resp) => return Ok(resp),
            };

            let msa = match refresh_msa_token(&client, &refresh_token).await {
                Ok(t) => t,
                Err(resp) => return Ok(resp),
            };

            let session = match complete_minecraft_session(&client, &app, msa).await {
                Ok(s) => s,
                Err(resp) => return Ok(resp),
            };

            if let Err(e) = persist_session(&app, &session).await {
                log::warn!("No se pudo persistir la sesión restaurada: {e}");
            }

            Ok(auth_ok(session.profile))
        }
    }
}

#[tauri::command]
pub async fn auth_upload_skin(
    app: AppHandle,
    uuid: String,
    image_data_url: String,
    model: String,
) -> Result<serde_json::Value, String> {
    use image::GenericImageView;

    let normalized_uuid = Uuid::parse_str(&uuid)
        .map_err(|_| "El identificador de la cuenta de Minecraft no es válido.".to_string())?
        .to_string();
    let variant = match model.to_ascii_lowercase().as_str() {
        "slim" | "alex" => "slim",
        "default" | "classic" | "steve" => "classic",
        _ => return Err("El modelo de skin debe ser Classic o Slim.".into()),
    };

    let encoded = image_data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| "El archivo seleccionado debe ser una imagen PNG válida.".to_string())?;
    if encoded.len() > 1_500_000 {
        return Err("La skin supera el tamaño máximo permitido de 1 MB.".into());
    }
    let image_bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "No se pudo leer el archivo PNG de la skin.".to_string())?;
    let image = image::load_from_memory_with_format(&image_bytes, image::ImageFormat::Png)
        .map_err(|_| "El archivo de skin no contiene un PNG válido.".to_string())?;
    let (width, height) = image.dimensions();
    if !((width == 64 && height == 64) || (width == 64 && height == 32)) {
        return Err(format!(
            "Minecraft requiere skins PNG de 64×64 o 64×32 píxeles; la imagen mide {width}×{height}."
        ));
    }

    let session = auth_restore_session(app.clone(), Some(normalized_uuid.clone()))
        .await
        .map_err(|error| format!("No se pudo renovar la sesión de Minecraft: {error}"))?;
    if !session.success {
        let message = session
            .error
            .map(|error| error.message)
            .unwrap_or_else(|| "No se pudo autenticar la cuenta de Minecraft.".into());
        return Err(message);
    }
    let profile = session
        .profile
        .ok_or_else(|| "La sesión no devolvió el perfil de Minecraft.".to_string())?;
    if !matches!(profile.account_type, AccountType::Microsoft) {
        return Err(
            "Las cuentas sin conexión no pueden publicar una skin en Minecraft.net.".into(),
        );
    }
    let access_token = profile
        .access_token
        .ok_or_else(|| "La sesión no contiene un token de Minecraft válido.".to_string())?;

    let client = http_client().map_err(|response| {
        response
            .error
            .map(|error| error.message)
            .unwrap_or_else(|| "No se pudo preparar la conexión con Minecraft.".into())
    })?;
    let file = reqwest::multipart::Part::bytes(image_bytes.clone())
        .file_name("skin.png")
        .mime_str("image/png")
        .map_err(|error| format!("No se pudo preparar el archivo de skin: {error}"))?;
    let form = reqwest::multipart::Form::new()
        .text("variant", variant.to_string())
        .part("file", file);
    let response = client
        .post("https://api.minecraftservices.com/minecraft/profile/skins")
        .bearer_auth(&access_token)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("No se pudo conectar con los servicios de Minecraft: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        let detail = detail.trim();
        return Err(match status.as_u16() {
            401 => "Minecraft rechazó la sesión. Cierra sesión en el launcher y vuelve a iniciar sesión.".into(),
            403 => "Minecraft no permitió cambiar la skin de esta cuenta.".into(),
            400 => "Minecraft rechazó la imagen. Usa un PNG de skin de 64×64 o 64×32 píxeles.".into(),
            _ if detail.is_empty() => format!("Minecraft rechazó la skin (HTTP {status})."),
            _ => format!("Minecraft rechazó la skin (HTTP {status}): {}", detail.chars().take(400).collect::<String>()),
        });
    }

    let cache_dir = skins_dir(&app);
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|error| format!("No se pudo preparar la caché de skins: {error}"))?;
    tokio::fs::write(
        cache_dir.join(format!("{normalized_uuid}.png")),
        &image_bytes,
    )
    .await
    .map_err(|error| {
        format!("La skin se subió, pero no se pudo actualizar la caché local: {error}")
    })?;
    if let Some(face_bytes) = crop_head_from_skin(&image_bytes) {
        let avatar_dir = avatars_dir(&app);
        tokio::fs::create_dir_all(&avatar_dir)
            .await
            .map_err(|error| {
                format!("La skin se subió, pero no se pudo actualizar el avatar local: {error}")
            })?;
        tokio::fs::write(
            avatar_dir.join(format!("{normalized_uuid}.png")),
            face_bytes,
        )
        .await
        .map_err(|error| {
            format!("La skin se subió, pero no se pudo guardar la nueva cara: {error}")
        })?;
    }

    Ok(serde_json::json!({ "success": true, "skinUrl": image_data_url }))
}

/// Comando: auth_login_offline
#[tauri::command]
pub async fn auth_login_offline(app: AppHandle, username: String) -> Result<AuthResponse, String> {
    let uuid_str = match offline_uuid_for(&username) {
        Ok(u) => u,
        Err(msg) => {
            return Ok(auth_fail(AuthErrorCode::NetworkError, msg));
        }
    };

    // Intento de obtener skin (Mojang) y avatar recortado; si falla, queda vacío.
    let client = http_client().ok();
    let skin_url = match &client {
        Some(c) => fetch_and_cache_skin(&app, c, &uuid_str, None).await,
        None => String::new(),
    };
    let avatar_url = get_avatar(&app, &uuid_str).await;

    let profile = MinecraftProfile {
        uuid: uuid_str,
        username,
        account_type: AccountType::Offline,
        access_token: None,
        skin_url,
        avatar_url,
        last_used: now_secs(),
    };

    if let Err(e) = upsert_profile(&app, &profile).await {
        log::warn!("No se pudo persistir el perfil offline: {e}");
    }

    Ok(auth_ok(profile))
}

/// Comando: auth_logout
#[tauri::command]
pub async fn auth_logout(app: AppHandle, uuid: String) -> Result<serde_json::Value, String> {
    let _ = delete_refresh_token(&uuid);
    let _ = remove_profile(&app, &uuid).await;
    let _ = tokio::fs::remove_file(skins_dir(&app).join(format!("{uuid}.png"))).await;
    let _ = tokio::fs::remove_file(avatars_dir(&app).join(format!("{uuid}.png"))).await;
    Ok(serde_json::json!({ "success": true }))
}

/// Comando: auth_get_saved_profiles
#[tauri::command]
pub async fn auth_get_saved_profiles(app: AppHandle) -> Result<Vec<MinecraftProfile>, String> {
    let file = load_profiles_file(&app).await;

    let mut profiles: Vec<MinecraftProfile> = Vec::with_capacity(file.profiles.len());
    for stored in file.profiles.into_values() {
        let skin_url = get_cached_skin(&app, &stored.uuid, &stored.skin_url).await;
        let avatar_url = get_avatar(&app, &stored.uuid).await;
        profiles.push(MinecraftProfile {
            uuid: stored.uuid,
            username: stored.username,
            account_type: stored.account_type,
            access_token: None,
            skin_url,
            avatar_url,
            last_used: stored.last_used,
        });
    }

    profiles.sort_by(|a, b| b.last_used.cmp(&a.last_used));
    Ok(profiles)
}
