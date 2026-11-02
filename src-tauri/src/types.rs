use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountType {
    Microsoft,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftProfile {
    pub uuid: String,
    pub username: String,
    pub account_type: AccountType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>, // Nunca se expone a la UI (se redacta)
    pub skin_url: String,
    pub avatar_url: String,
    pub last_used: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<MinecraftProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AuthError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthError {
    pub code: AuthErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AuthErrorCode {
    AuthCanceled,
    NetworkError,
    TokenExpired,
    KeyringError,
    NoMinecraftLicense,
}

// --- Sync ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SyncStage {
    FetchingManifest,
    VerifyingHashes,
    DownloadingJava,
    DownloadingModpack,
    DownloadingAssets,
    ExtractingArchive,
    SealingVault,
    UnsealingVault,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub instance_id: String,
    pub force_repair: bool,
    #[serde(default)]
    pub url_modpack: Option<String>,
    #[serde(default)]
    pub version_pack: Option<u64>,
    #[serde(default)]
    pub manifest: Option<serde_json::Value>,
    #[serde(default)]
    pub download_limit_kbps: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgressEvent {
    pub instance_id: String,
    pub stage: SyncStage,
    pub current_file: String,
    pub bytes_processed: u64,
    pub bytes_total: u64,
    pub files_processed: u64,
    pub files_total: u64,
    pub speed_bps: f64,
    pub eta_seconds: f64,
}

// --- Launch ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    pub instance_id: String,
    pub profile_uuid: String,
    #[serde(default)]
    pub version_mc: Option<String>,
    #[serde(default)]
    pub tipo_loader: Option<String>,
    #[serde(default)]
    pub loader_version: Option<String>,
    #[serde(default)]
    pub url_loader: Option<String>,
    #[serde(default)]
    pub java_version: Option<String>,
    pub memory_mb: MemoryMb,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<Resolution>,
    pub custom_jvm_args: Vec<String>,
    pub close_launcher_on_start: CloseLauncherOnStart,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMb {
    pub min: u32,
    pub max: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
    pub fullscreen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseLauncherOnStart {
    Hide,
    KeepOpen,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashDiagnostic {
    pub exit_code: i32,
    pub probable_causes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crash_report_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exception_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GameState {
    Preparing,
    StartingJvm,
    Running,
    Stopped,
    Crashed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameStateEvent {
    pub instance_id: String,
    pub state: GameState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameLogLine {
    pub timestamp: String,
    pub level: LogLevel,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameLogBatchEvent {
    pub instance_id: String,
    pub lines: Vec<GameLogLine>,
}

// --- Server Status (SLP) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub online: bool,
    pub ping_ms: u32,
    pub players_online: u32,
    pub players_max: u32,
    pub motd: String,
    pub version: String,
}

// --- Crash Diagnostics ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportInfo {
    pub title: String,
    pub reason: String,
    pub suggestion: String,
    pub raw_snippet: String,
    pub crash_file: Option<String>,
}

// --- Screenshots ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotItem {
    pub file_name: String,
    pub file_path: String,
    pub created_at: u64,
    pub thumbnail_base64: Option<String>,
    pub size_bytes: u64,
}

// --- Theme System ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct InstanceTheme {
    pub accent_color: String,
    pub background_image: Option<String>,
    pub particle_type: String,
}
