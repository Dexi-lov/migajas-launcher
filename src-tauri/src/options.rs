// src-tauri/src/options.rs
//
// Lee y escribe `options.txt` por instancia, y escanea `resourcepacks/`.
//   1. get_game_options    → parsea options.txt (defaults si no existe).
//   2. save_game_options   → escritura atómica, preserva claves desconocidas.
//   3. list_resourcepacks  → escanea resourcepacks/ y lee pack.mcmeta + pack.png.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

/// Contenido mínimo de un `options.txt` recién creado.
/// Minecraft rellenará el resto de claves con sus defaults al primer arranque.
const DEFAULT_OPTIONS_TXT: &str = r#"renderDistance:12
fov:70
maxFps:120
fullscreen:false
guiScale:0
graphicsMode:1
gamma:0.5
soundCategory_master:1.0
soundCategory_music:1.0
soundCategory_record:1.0
soundCategory_weather:1.0
soundCategory_block:1.0
soundCategory_hostile:1.0
soundCategory_neutral:1.0
soundCategory_player:1.0
soundCategory_ambient:1.0
soundCategory_voice:1.0
resourcePacks:["vanilla"]
key_key.attack:key.mouse.left
key_key.use:key.mouse.right
key_key.forward:key.keyboard.w
key_key.back:key.keyboard.s
key_key.left:key.keyboard.a
key_key.right:key.keyboard.d
key_key.jump:key.keyboard.space
key_key.sneak:key.keyboard.left.shift
key_key.sprint:key.keyboard.left.control
key_key.drop:key.keyboard.q
key_key.inventory:key.keyboard.e
key_key.chat:key.keyboard.t
key_key.playerlist:key.keyboard.tab
key_key.pickItem:key.mouse.middle
key_key.command:key.keyboard.slash
key_key.togglePerspective:key.keyboard.f5
key_key.screenshot:key.keyboard.f2
key_key.fullscreen:key.keyboard.f11
key_key.swapOffhand:key.keyboard.f
key_key.hotbar.1:key.keyboard.1
key_key.hotbar.2:key.keyboard.2
key_key.hotbar.3:key.keyboard.3
key_key.hotbar.4:key.keyboard.4
key_key.hotbar.5:key.keyboard.5
key_key.hotbar.6:key.keyboard.6
key_key.hotbar.7:key.keyboard.7
key_key.hotbar.8:key.keyboard.8
key_key.hotbar.9:key.keyboard.9
mouseSensitivity:0.5
"#;

// ─────────────────────────────────────────────────────────────────────────
// Tipos públicos (contrato IPC)
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameOptions {
    pub graphics: GraphicsOptions,
    pub audio: AudioOptions,
    #[serde(default = "default_mouse_sensitivity")]
    pub mouse_sensitivity: f32,
    /// Claves por acción: `{ "key.attack": "key.mouse.left", ... }`
    pub controls: HashMap<String, String>,
    /// Lista de packs activos tal cual van en `resourcePacks:[...]`
    pub resource_packs: Vec<String>,
}

fn default_mouse_sensitivity() -> f32 {
    0.5
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsOptions {
    pub fov: u32,
    pub render_distance: u32,
    pub max_fps: u32,
    pub fullscreen: bool,
    pub gui_scale: u32,
    /// "fast" | "fancy" | "fabulous"
    pub graphics_mode: String,
    pub gamma: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOptions {
    pub master: f32,
    pub music: f32,
    pub record: f32,
    pub weather: f32,
    pub block: f32,
    pub hostile: f32,
    pub neutral: f32,
    pub player: f32,
    pub ambient: f32,
    pub voice: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePackInfo {
    /// Identificador tal cual aparece en `resourcePacks`: `"vanilla"` o `"file/nombre.zip"`.
    pub id: String,
    pub name: String,
    pub description: String,
    pub pack_format: i32,
    /// `data:image/png;base64,...` si tiene `pack.png`, si no `None`.
    pub icon_data_url: Option<String>,
    pub active: bool,
    pub is_directory: bool,
    pub compatible: bool,
}

// ─────────────────────────────────────────────────────────────────────────
// Helper público: ruta de la instancia
// ─────────────────────────────────────────────────────────────────────────

/// Resuelve `{app_data_dir}/instances/{instance_id}` validando el ID.
/// `launch.rs` debe usar esta misma función para que mods y options.txt
/// apunten al mismo directorio.
pub fn instance_dir(app: &AppHandle, instance_id: &str) -> Result<PathBuf, String> {
    if instance_id.is_empty()
        || instance_id.len() > 64
        || !instance_id
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        return Err("instance_id inválido".into());
    }
    app.path()
        .app_data_dir()
        .map(|d| d.join("instances").join(instance_id))
        .map_err(|e| format!("app_data_dir: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────
// Comandos IPC
// ─────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_game_options(app: AppHandle, instance_id: String) -> Result<GameOptions, String> {
    let dir = instance_dir(&app, &instance_id)?;
    tokio::task::spawn_blocking(move || load_options(&dir))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn save_game_options(
    app: AppHandle,
    instance_id: String,
    options: GameOptions,
) -> Result<bool, String> {
    let dir = instance_dir(&app, &instance_id)?;
    tokio::task::spawn_blocking(move || write_options(&dir, &options))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub async fn list_resourcepacks(
    app: AppHandle,
    instance_id: String,
) -> Result<Vec<ResourcePackInfo>, String> {
    let dir = instance_dir(&app, &instance_id)?;
    tokio::task::spawn_blocking(move || scan_resourcepacks(&dir))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

// ─────────────────────────────────────────────────────────────────────────
// Implementación bloqueante (se ejecuta en spawn_blocking)
// ─────────────────────────────────────────────────────────────────────────

fn load_options(dir: &Path) -> Result<GameOptions, String> {
    let map = read_raw_options(dir);
    Ok(parse_options(&map))
}

fn read_raw_options(dir: &Path) -> HashMap<String, String> {
    let path = dir.join("options.txt");
    let content =
        std::fs::read_to_string(&path).unwrap_or_else(|_| DEFAULT_OPTIONS_TXT.to_string());
    let mut map = HashMap::new();
    for line in content.lines() {
        let line = line.trim_end_matches('\r');
        if let Some((k, v)) = line.split_once(':') {
            map.insert(k.to_string(), v.to_string());
        }
    }
    map
}

fn parse_options(map: &HashMap<String, String>) -> GameOptions {
    let s = |k: &str, def: &str| map.get(k).cloned().unwrap_or_else(|| def.to_string());
    let f = |k: &str, def: f32| map.get(k).and_then(|v| v.parse().ok()).unwrap_or(def);
    let u = |k: &str, def: u32| map.get(k).and_then(|v| v.parse().ok()).unwrap_or(def);
    let b = |k: &str, def: bool| map.get(k).and_then(|v| v.parse().ok()).unwrap_or(def);

    let graphics = GraphicsOptions {
        fov: u("fov", 70).clamp(30, 110),
        render_distance: u("renderDistance", 12),
        max_fps: u("maxFps", 120),
        fullscreen: b("fullscreen", false),
        gui_scale: u("guiScale", 0),
        graphics_mode: graphics_mode_from_int(&s("graphicsMode", "1")),
        gamma: f("gamma", 0.5),
    };

    let audio = AudioOptions {
        master: f("soundCategory_master", 1.0),
        music: f("soundCategory_music", 1.0),
        record: f("soundCategory_record", 1.0),
        weather: f("soundCategory_weather", 1.0),
        block: f("soundCategory_block", 1.0),
        hostile: f("soundCategory_hostile", 1.0),
        neutral: f("soundCategory_neutral", 1.0),
        player: f("soundCategory_player", 1.0),
        ambient: f("soundCategory_ambient", 1.0),
        voice: f("soundCategory_voice", 1.0),
    };

    // Controls: `key_key.attack` → `key.attack`
    let mut controls = HashMap::new();
    for (k, v) in map {
        if let Some(action) = k.strip_prefix("key_") {
            controls.insert(action.to_string(), v.clone());
        }
    }

    let resource_packs = parse_resource_packs(&s("resourcePacks", r#"["vanilla"]"#));

    let mouse_sensitivity = f("mouseSensitivity", default_mouse_sensitivity());
    let mouse_sensitivity = if mouse_sensitivity.is_finite() {
        mouse_sensitivity.clamp(0.0, 1.0)
    } else {
        default_mouse_sensitivity()
    };

    GameOptions {
        graphics,
        audio,
        mouse_sensitivity,
        controls,
        resource_packs,
    }
}

fn parse_resource_packs(value: &str) -> Vec<String> {
    // Formato moderno: array JSON válido
    if value.starts_with('[') {
        if let Ok(v) = serde_json::from_str::<Vec<String>>(value) {
            return v;
        }
    }
    // Fallback legacy: separado por comas
    value
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn graphics_mode_from_int(s: &str) -> String {
    match s.trim() {
        "0" => "fast".into(),
        "1" => "fancy".into(),
        "2" => "fabulous".into(),
        other => other.to_string(),
    }
}

fn graphics_mode_to_int(s: &str) -> String {
    match s.to_lowercase().as_str() {
        "fast" => "0".into(),
        "fancy" => "1".into(),
        "fabulous" => "2".into(),
        _ => "1".into(),
    }
}

fn write_options(dir: &Path, opts: &GameOptions) -> Result<bool, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let path = dir.join("options.txt");

    // ── 1. Leer existentes para preservar claves de mods ─────────────────
    let mut entries: Vec<(String, String)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    if let Ok(content) = std::fs::read_to_string(&path) {
        for line in content.lines() {
            let line = line.trim_end_matches('\r');
            if let Some((k, v)) = line.split_once(':') {
                if k.is_empty() {
                    continue;
                }
                let k = k.to_string();
                if !index.contains_key(&k) {
                    index.insert(k.clone(), entries.len());
                    entries.push((k, v.to_string()));
                }
            }
        }
    }

    fn set(
        entries: &mut Vec<(String, String)>,
        index: &mut HashMap<String, usize>,
        k: &str,
        v: String,
    ) {
        if let Some(&i) = index.get(k) {
            entries[i].1 = v;
        } else {
            index.insert(k.to_string(), entries.len());
            entries.push((k.to_string(), v));
        }
    }

    // ── 2. Gráficos ──────────────────────────────────────────────────────
    set(
        &mut entries,
        &mut index,
        "fov",
        opts.graphics.fov.clamp(30, 110).to_string(),
    );
    set(
        &mut entries,
        &mut index,
        "renderDistance",
        opts.graphics.render_distance.to_string(),
    );
    set(
        &mut entries,
        &mut index,
        "maxFps",
        opts.graphics.max_fps.to_string(),
    );
    set(
        &mut entries,
        &mut index,
        "fullscreen",
        opts.graphics.fullscreen.to_string(),
    );
    set(
        &mut entries,
        &mut index,
        "guiScale",
        opts.graphics.gui_scale.to_string(),
    );
    set(
        &mut entries,
        &mut index,
        "graphicsMode",
        graphics_mode_to_int(&opts.graphics.graphics_mode),
    );
    set(
        &mut entries,
        &mut index,
        "gamma",
        format_float(opts.graphics.gamma),
    );
    let mouse_sensitivity = if opts.mouse_sensitivity.is_finite() {
        opts.mouse_sensitivity.clamp(0.0, 1.0)
    } else {
        default_mouse_sensitivity()
    };
    set(
        &mut entries,
        &mut index,
        "mouseSensitivity",
        format_float(mouse_sensitivity),
    );

    // ── 3. Audio ─────────────────────────────────────────────────────────
    set(
        &mut entries,
        &mut index,
        "soundCategory_master",
        format_float(opts.audio.master),
    );
    set(
        &mut entries,
        &mut index,
        "soundCategory_music",
        format_float(opts.audio.music),
    );
    set(
        &mut entries,
        &mut index,
        "soundCategory_record",
        format_float(opts.audio.record),
    );
    set(
        &mut entries,
        &mut index,
        "soundCategory_weather",
        format_float(opts.audio.weather),
    );
    set(
        &mut entries,
        &mut index,
        "soundCategory_block",
        format_float(opts.audio.block),
    );
    set(
        &mut entries,
        &mut index,
        "soundCategory_hostile",
        format_float(opts.audio.hostile),
    );
    set(
        &mut entries,
        &mut index,
        "soundCategory_neutral",
        format_float(opts.audio.neutral),
    );
    set(
        &mut entries,
        &mut index,
        "soundCategory_player",
        format_float(opts.audio.player),
    );
    set(
        &mut entries,
        &mut index,
        "soundCategory_ambient",
        format_float(opts.audio.ambient),
    );
    set(
        &mut entries,
        &mut index,
        "soundCategory_voice",
        format_float(opts.audio.voice),
    );

    // ── 4. Controles (`key.attack` → `key_key.attack`) ──────────────────
    for (action, key) in &opts.controls {
        let full_key = format!("key_{action}");
        set(&mut entries, &mut index, &full_key, key.clone());
    }

    // ── 5. ResourcePacks (sintaxis exacta de Minecraft) ─────────────────
    let rp_json =
        serde_json::to_string(&opts.resource_packs).map_err(|e| format!("serialize packs: {e}"))?;
    set(&mut entries, &mut index, "resourcePacks", rp_json);

    // ── 6. Serializar con finales de línea `\n` (Minecraft acepta ambos) ─
    let mut out = String::with_capacity(entries.iter().map(|(k, v)| k.len() + v.len() + 2).sum());
    for (k, v) in &entries {
        out.push_str(k);
        out.push(':');
        out.push_str(v);
        out.push('\n');
    }

    // ── 7. Escritura atómica: temp + rename ─────────────────────────────
    let tmp = path.with_extension("txt.tmp");
    std::fs::write(&tmp, out.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;

    Ok(true)
}

/// Formatea floats con `1.0` en lugar de `1` (paridad con Minecraft).
fn format_float(v: f32) -> String {
    if v.fract() == 0.0 {
        format!("{v:.1}")
    } else {
        format!("{v}")
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Escaneo de resourcepacks
// ─────────────────────────────────────────────────────────────────────────

fn scan_resourcepacks(dir: &Path) -> Result<Vec<ResourcePackInfo>, String> {
    let rp_dir = dir.join("resourcepacks");

    // Packs activos según options.txt
    let map = read_raw_options(dir);
    let active = parse_resource_packs(
        map.get("resourcePacks")
            .map(|s| s.as_str())
            .unwrap_or(r#"["vanilla"]"#),
    );

    let mut result = Vec::new();

    // "vanilla" siempre está presente (built-in de Minecraft)
    result.push(ResourcePackInfo {
        id: "vanilla".into(),
        name: "Default".into(),
        description: "The default look and feel of Minecraft".into(),
        pack_format: 0,
        icon_data_url: None,
        active: active.iter().any(|a| a == "vanilla"),
        is_directory: false,
        compatible: true,
    });

    if !rp_dir.exists() {
        return Ok(result);
    }

    let rd =
        std::fs::read_dir(&rp_dir).map_err(|e| format!("read_dir {}: {e}", rp_dir.display()))?;

    for entry in rd.flatten() {
        let path = entry.path();
        let fname = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if fname.is_empty() || fname.starts_with('.') {
            continue;
        }

        let is_dir = path.is_dir();
        let is_zip = path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("zip");
        if !is_dir && !is_zip {
            continue;
        }

        // Leer pack.mcmeta y pack.png
        let entries = if is_zip {
            read_zip_entries(&path, &["pack.mcmeta", "pack.png"]).unwrap_or_default()
        } else {
            read_dir_entries(&path, &["pack.mcmeta", "pack.png"])
        };

        let mcmeta = entries
            .get("pack.mcmeta")
            .and_then(|b| std::str::from_utf8(b).ok())
            .and_then(parse_mcmeta);

        let (pack_format, description) = mcmeta.unwrap_or_else(|| (0, fname.to_string()));

        let icon_data_url = entries.get("pack.png").map(|b| {
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(b)
            )
        });

        let id = format!("file/{fname}");
        let active_flag = active.iter().any(|a| a == &id);

        result.push(ResourcePackInfo {
            id,
            name: fname.to_string(),
            description,
            pack_format,
            icon_data_url,
            active: active_flag,
            is_directory: is_dir,
            compatible: true, // TODO: comparar con el pack_format de la versión MC
        });
    }

    // Orden estable: activos primero, luego por nombre
    result.sort_by(|a, b| {
        b.active
            .cmp(&a.active)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

fn read_zip_entries(path: &Path, names: &[&str]) -> Result<HashMap<String, Vec<u8>>, String> {
    let file =
        std::fs::File::open(path).map_err(|e| format!("open zip {}: {e}", path.display()))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("read zip {}: {e}", path.display()))?;

    let mut out = HashMap::new();
    for name in names {
        if let Ok(mut f) = archive.by_name(name) {
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() {
                out.insert(name.to_string(), buf);
            }
        }
    }
    Ok(out)
}

fn read_dir_entries(path: &Path, names: &[&str]) -> HashMap<String, Vec<u8>> {
    let mut out = HashMap::new();
    for name in names {
        let p = path.join(name);
        if let Ok(buf) = std::fs::read(&p) {
            out.insert(name.to_string(), buf);
        }
    }
    out
}

fn parse_mcmeta(content: &str) -> Option<(i32, String)> {
    let v: serde_json::Value = serde_json::from_str(content).ok()?;
    let pack = v.get("pack")?;
    let format = pack.get("pack_format").and_then(|v| v.as_i64())? as i32;
    let description = pack
        .get("description")
        .map(extract_description)
        .unwrap_or_default();
    Some((format, description))
}

/// Extrae el texto plano de un `description` (string o componente chat).
fn extract_description(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(o) => {
            let mut out = String::new();
            if let Some(t) = o.get("text").and_then(|x| x.as_str()) {
                out.push_str(t);
            }
            if let Some(extra) = o.get("extra").and_then(|x| x.as_array()) {
                for e in extra {
                    out.push_str(&extract_description(e));
                }
            }
            out
        }
        serde_json::Value::Array(a) => a
            .iter()
            .map(extract_description)
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_resource_packs_json() {
        let v = parse_resource_packs(r#"["vanilla","file/my_pack.zip"]"#);
        assert_eq!(v, vec!["vanilla", "file/my_pack.zip"]);
    }

    #[test]
    fn parse_resource_packs_empty() {
        assert!(parse_resource_packs("[]").is_empty());
    }

    #[test]
    fn graphics_mode_roundtrip() {
        assert_eq!(graphics_mode_from_int("0"), "fast");
        assert_eq!(graphics_mode_from_int("1"), "fancy");
        assert_eq!(graphics_mode_from_int("2"), "fabulous");
        assert_eq!(graphics_mode_to_int("fast"), "0");
        assert_eq!(graphics_mode_to_int("fancy"), "1");
        assert_eq!(graphics_mode_to_int("fabulous"), "2");
        assert_eq!(graphics_mode_to_int("unknown"), "1");
    }

    #[test]
    fn options_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let opts = GameOptions {
            mouse_sensitivity: 0.5,
            graphics: GraphicsOptions {
                fov: 90,
                render_distance: 16,
                max_fps: 240,
                fullscreen: true,
                gui_scale: 2,
                graphics_mode: "fancy".into(),
                gamma: 0.75,
            },
            audio: AudioOptions {
                master: 0.8,
                music: 0.5,
                record: 1.0,
                weather: 1.0,
                block: 1.0,
                hostile: 1.0,
                neutral: 1.0,
                player: 1.0,
                ambient: 1.0,
                voice: 1.0,
            },
            controls: {
                let mut m = HashMap::new();
                m.insert("key.attack".to_string(), "key.mouse.left".to_string());
                m
            },
            resource_packs: vec!["vanilla".into(), "file/test.zip".into()],
        };

        write_options(dir.path(), &opts).unwrap();
        let loaded = load_options(dir.path()).unwrap();

        assert_eq!(loaded.graphics.render_distance, 16);
        assert_eq!(loaded.graphics.fov, 90);
        assert_eq!(loaded.graphics.max_fps, 240);
        assert!(loaded.graphics.fullscreen);
        assert_eq!(loaded.graphics.gui_scale, 2);
        assert_eq!(loaded.graphics.graphics_mode, "fancy");
        assert!((loaded.graphics.gamma - 0.75).abs() < 0.01);
        assert!((loaded.audio.master - 0.8).abs() < 0.01);
        assert_eq!(loaded.controls.get("key.attack").unwrap(), "key.mouse.left");
        assert_eq!(loaded.resource_packs, vec!["vanilla", "file/test.zip"]);
    }

    #[test]
    fn preserves_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("options.txt");
        std::fs::write(
            &path,
            "renderDistance:8\nsomeModKey:customValue\nmaxFps:60\n",
        )
        .unwrap();

        let mut opts = load_options(dir.path()).unwrap();
        opts.graphics.render_distance = 32;
        write_options(dir.path(), &opts).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("someModKey:customValue"));
        assert!(content.contains("renderDistance:32"));
    }

    #[test]
    fn mcmeta_description_string() {
        let mc = r#"{"pack":{"pack_format":15,"description":"Simple Pack"}}"#;
        let (fmt, desc) = parse_mcmeta(mc).unwrap();
        assert_eq!(fmt, 15);
        assert_eq!(desc, "Simple Pack");
    }

    #[test]
    fn mcmeta_description_chat_object() {
        let mc = r#"{"pack":{"pack_format":15,"description":{"text":"Fancy ","extra":[{"text":"Pack"}]}}}"#;
        let (_, desc) = parse_mcmeta(mc).unwrap();
        assert_eq!(desc, "Fancy Pack");
    }

    #[test]
    fn defaults_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let opts = load_options(dir.path()).unwrap();
        assert_eq!(opts.graphics.render_distance, 12);
        assert_eq!(opts.graphics.fov, 70);
        assert_eq!(opts.graphics.graphics_mode, "fancy");
        assert!(opts.resource_packs.contains(&"vanilla".to_string()));
    }
}
