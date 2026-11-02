use crate::{options::instance_dir, types::ScreenshotItem};
use base64::Engine as _;
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};
use tauri::AppHandle;
const MAX_IMAGE: u64 = 64 * 1024 * 1024;
fn reject_link(path: &Path) -> Result<(), String> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        #[cfg(windows)]
        let reparse = {
            use std::os::windows::fs::MetadataExt;
            meta.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let reparse = false;
        if meta.file_type().is_symlink() || reparse {
            return Err("No se permiten enlaces en la carpeta de capturas.".into());
        }
    }
    Ok(())
}
fn folder(instance: &Path, create: bool) -> Result<PathBuf, String> {
    reject_link(instance)?;
    let dir = instance.join("screenshots");
    reject_link(&dir)?;
    if create {
        if !instance.is_dir() {
            return Err("La instancia no está instalada.".into());
        }
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}
fn capture_path(instance: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty()
        || name.contains(['/', '\\', ':'])
        || !name.to_ascii_lowercase().ends_with(".png")
        || name.chars().any(|c| c < ' ')
    {
        return Err("Nombre de captura inválido.".into());
    }
    let dir = folder(instance, false)?;
    let path = dir.join(name);
    reject_link(&path)?;
    if path.exists() {
        let root = dir.canonicalize().map_err(|e| e.to_string())?;
        let full = path.canonicalize().map_err(|e| e.to_string())?;
        if full.parent() != Some(root.as_path()) || !full.is_file() {
            return Err("La captura no pertenece a esta instancia.".into());
        }
    }
    Ok(path)
}
#[tauri::command]
pub async fn get_screenshots(
    app: AppHandle,
    instance_id: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Vec<ScreenshotItem>, String> {
    let dir = instance_dir(&app, &instance_id)?;
    tokio::task::spawn_blocking(move || {
        list_screenshots(&dir, offset.unwrap_or(0), limit.unwrap_or(48).clamp(1, 100))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn get_screenshot_image(
    app: AppHandle,
    instance_id: String,
    file_name: String,
) -> Result<String, String> {
    let dir = instance_dir(&app, &instance_id)?;
    tokio::task::spawn_blocking(move || {
        let path = capture_path(&dir, &file_name)?;
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_IMAGE {
            return Err("La captura supera 64 MiB.".into());
        }
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("La captura no es un PNG válido.".into());
        }
        let (width, height) = image::ImageReader::new(Cursor::new(bytes.as_slice()))
            .with_guessed_format()
            .map_err(|e| e.to_string())?
            .into_dimensions()
            .map_err(|e| format!("PNG dañado: {e}"))?;
        if width > 16384
            || height > 16384
            || u64::from(width) * u64::from(height) > 64 * 1024 * 1024
        {
            return Err("La captura supera el tamaño de imagen admitido.".into());
        }
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn open_screenshot_folder(app: AppHandle, instance_id: String) -> Result<(), String> {
    let dir = instance_dir(&app, &instance_id)?;
    tokio::task::spawn_blocking(move || {
        let screenshots = folder(&dir, true)?;
        open::that(screenshots).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn delete_screenshot(
    app: AppHandle,
    instance_id: String,
    file_name: String,
) -> Result<bool, String> {
    let dir = instance_dir(&app, &instance_id)?;
    tokio::task::spawn_blocking(move || delete_capture(&dir, &file_name))
        .await
        .map_err(|e| e.to_string())?
}
fn delete_capture(instance: &Path, name: &str) -> Result<bool, String> {
    let path = capture_path(instance, name)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}
fn list_screenshots(
    instance: &Path,
    offset: usize,
    limit: usize,
) -> Result<Vec<ScreenshotItem>, String> {
    let dir = folder(instance, false)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut files = vec![];
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_ascii_lowercase().ends_with(".png") {
            continue;
        }
        let path = match capture_path(instance, &name) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
        let created_at = meta
            .modified()
            .or_else(|_| meta.created())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|t| t.as_secs())
            .unwrap_or(0);
        files.push(ScreenshotItem {
            file_name: name,
            file_path: path.to_string_lossy().into(),
            created_at,
            thumbnail_base64: None,
            size_bytes: meta.len(),
        });
    }
    files.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then(b.file_name.cmp(&a.file_name))
    });
    Ok(files
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|mut item| {
            item.thumbnail_base64 = thumbnail(Path::new(&item.file_path)).ok();
            item
        })
        .collect())
}
fn thumbnail(path: &Path) -> Result<String, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_IMAGE {
        return Err("Imagen demasiado grande.".into());
    }
    let mut reader = image::ImageReader::open(path).map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|e| e.to_string())?
        .thumbnail(320, 180);
    let mut bytes = Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn produces_a_complete_resized_png() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("test.png");
        image::RgbImage::from_fn(1600, 900, |x, y| {
            image::Rgb([(x % 255) as u8, (y % 255) as u8, 90])
        })
        .save(&file)
        .unwrap();
        let encoded = thumbnail(&file).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.split_once(',').unwrap().1)
            .unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (320, 180));
    }
    #[test]
    fn cannot_delete_outside_the_capture_folder() {
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside.png");
        fs::write(&outside, b"test").unwrap();
        assert!(delete_capture(temp.path(), "../outside.png").is_err());
        assert!(delete_capture(temp.path(), "C:\\outside.png").is_err());
        assert!(delete_capture(temp.path(), "notes.txt").is_err());
        assert!(outside.exists());
    }
    #[test]
    fn pages_and_deletes_only_named_captures() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("screenshots")).unwrap();
        for name in ["one.png", "two.PNG"] {
            image::RgbImage::new(8, 8)
                .save_with_format(
                    temp.path().join("screenshots").join(name),
                    image::ImageFormat::Png,
                )
                .unwrap();
        }
        assert_eq!(list_screenshots(temp.path(), 0, 1).unwrap().len(), 1);
        assert_eq!(list_screenshots(temp.path(), 1, 48).unwrap().len(), 1);
        assert!(delete_capture(temp.path(), "one.png").unwrap());
        assert_eq!(list_screenshots(temp.path(), 0, 48).unwrap().len(), 1);
    }
}
