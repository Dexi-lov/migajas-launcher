// src-tauri/src/vault.rs
//
// Protección de mods `.jar`:
//   1. Almacenamiento cifrado AES-256-GCM en `.vault/`.
//   2. Descifrado efímero JIT en `mods/` justo antes de lanzar Java.
//   3. Atributos HIDDEN | SYSTEM en Windows (Win32 API directa).
//   4. Bloqueo exclusivo (sharing lock) mientras el juego corre.
//   5. Shred (sobrescritura + borrado) al terminar o al cerrar el launcher.
//   6. Redacción de rutas `.jar` en logs y argumentos JVM.

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, OsRng},
};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use zeroize::Zeroize;

/// Clave maestra embebida (32 bytes exactos). **Sustitúyela por 32 bytes
/// aleatorios propios antes de producción.** No es seguridad fuerte contra
/// reversing; ver nota al final del archivo.
const MASTER_SECRET: &[u8; 32] = b"CAMBIA_ESTO_32_BYTES_ALEATORIOS!";

/// Salt fijo para derivar la clave AES (16 bytes).
const KEY_SALT: &[u8; 16] = b"migajas-vault-v1";

const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// `GENERIC_READ` — valor oficial de Win32 (0x80000000).
/// Se declara como literal para evitar depender de la ruta exacta de la
/// constante en `windows-sys`, que cambia entre versiones.
#[cfg(windows)]
const GENERIC_READ: u32 = 0x8000_0000;

// ─────────────────────────────────────────────────────────────────────────
// Estado global: instancias con mods descifrados (para el kill-switch)
// ─────────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct VaultState {
    /// instance_id -> carpetas con mods materializados temporalmente.
    pub active: Mutex<HashMap<String, ActiveMods>>,
    /// instance_id -> rutas de `.vault/` de origen.
    #[allow(dead_code)]
    pub vault_sources: Mutex<HashMap<String, PathBuf>>,
}

#[derive(Clone)]
pub struct ActiveMods {
    pub vault_dir: PathBuf,
    pub mods_dir: PathBuf,
}

impl VaultState {
    pub fn mark_active(&self, instance_id: &str, vault_dir: PathBuf, mods_dir: PathBuf) {
        if let Ok(mut m) = self.active.lock() {
            m.insert(instance_id.to_string(), ActiveMods { vault_dir, mods_dir });
        }
    }

    pub fn clear_active(&self, instance_id: &str) {
        if let Ok(mut m) = self.active.lock() {
            m.remove(instance_id);
        }
    }

    /// Kill-switch: limpia TODAS las instancias activas (usado al cerrar la app).
    pub fn cleanup_all(&self) {
        if let Ok(mut m) = self.active.lock() {
            for (_id, active) in m.drain() {
                let _ = cleanup_materialized_mods(&active.vault_dir, &active.mods_dir);
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Derivación de clave y cifrado/descifrado AES-256-GCM
// ─────────────────────────────────────────────────────────────────────────

fn derive_key() -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(MASTER_SECRET);
    hasher.update(KEY_SALT);
    let digest = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

/// Cifra `plaintext_path` y escribe `[nonce(12) || ciphertext+tag]` en `dest`.
#[allow(dead_code)]
pub fn encrypt_file(plaintext_path: &Path, dest: &Path) -> Result<(), String> {
    let mut plaintext = Vec::new();
    fs::File::open(plaintext_path)
        .and_then(|mut f| f.read_to_end(&mut plaintext))
        .map_err(|e| format!("leer {}: {e}", plaintext_path.display()))?;

    let key = derive_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("key: {e}"))?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("encrypt: {e}"))?;

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }

    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);

    fs::write(dest, &out).map_err(|e| format!("escribir {}: {e}", dest.display()))?;

    plaintext.zeroize();
    Ok(())
}

/// Descifra un archivo `.vault` a `dest`. Formato: `[nonce(12) || ciphertext+tag]`.
pub fn decrypt_file(vault_path: &Path, dest: &Path) -> Result<(), String> {
    let mut data = Vec::new();
    fs::File::open(vault_path)
        .and_then(|mut f| f.read_to_end(&mut data))
        .map_err(|e| format!("leer {}: {e}", vault_path.display()))?;

    if data.len() < NONCE_LEN + TAG_LEN {
        return Err(format!("archivo vault truncado: {}", vault_path.display()));
    }

    let (nonce_bytes, ciphertext) = data.split_at(NONCE_LEN);
    let nonce = Nonce::from_slice(nonce_bytes);

    let key = derive_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("key: {e}"))?;

    let mut plaintext = cipher.decrypt(nonce, ciphertext).map_err(|_| {
        format!(
            "descifrado falló (¿clave o integridad?): {}",
            vault_path.display()
        )
    })?;

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }

    let mut f = fs::File::create(dest).map_err(|e| format!("crear {}: {e}", dest.display()))?;
    f.write_all(&plaintext)
        .map_err(|e| format!("escribir {}: {e}", dest.display()))?;
    f.sync_all()
        .map_err(|e| format!("sync {}: {e}", dest.display()))?;

    plaintext.zeroize();
    data.zeroize();
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// Materialización JIT de una instancia
// ─────────────────────────────────────────────────────────────────────────

/// Descifra todos los `.jar.enc` de `.vault/` a `mods/`, aplica atributos y
/// devuelve los locks que deben mantenerse vivos mientras corre Java.
pub fn materialize_mods(
    instance_id: &str,
    vault_dir: &Path,
    mods_dir: &Path,
) -> Result<Vec<FileLock>, String> {
    fs::create_dir_all(mods_dir).map_err(|e| format!("mkdir mods: {e}"))?;

    hide_path(mods_dir)?;

    let mut locks = Vec::new();

    let entries = fs::read_dir(vault_dir).map_err(|e| format!("read vault: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("enc") {
            continue;
        }

        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("mod");
        let jar_name = stem
            .strip_suffix(".jar")
            .map(|s| format!("{s}.jar"))
            .unwrap_or_else(|| format!("{stem}.jar"));
        let dest = mods_dir.join(&jar_name);

        decrypt_file(&path, &dest)?;
        hide_path(&dest)?;

        let lock = lock_file_exclusive(&dest)?;
        locks.push(lock);
    }

    log::info!(
        "[vault] instancia {instance_id}: {} JARs materializados y bloqueados",
        locks.len()
    );
    Ok(locks)
}

/// Elimina únicamente los JARs que proceden del vault; conserva los mods
/// instalados normalmente en `mods/` por el modpack.
pub fn cleanup_materialized_mods(vault_dir: &Path, mods_dir: &Path) -> Result<(), String> {
    if !vault_dir.is_dir() || !mods_dir.is_dir() {
        return Ok(());
    }

    let entries = fs::read_dir(vault_dir).map_err(|e| format!("read vault: {e}"))?;
    for entry in entries.flatten() {
        let encrypted_path = entry.path();
        if encrypted_path.extension().and_then(|ext| ext.to_str()) != Some("enc") {
            continue;
        }
        let stem = encrypted_path.file_stem().and_then(|s| s.to_str()).unwrap_or("mod");
        let jar_name = stem
            .strip_suffix(".jar")
            .map(|s| format!("{s}.jar"))
            .unwrap_or_else(|| format!("{stem}.jar"));
        let path = mods_dir.join(jar_name);
        if path.is_file() {
            unhide_path(&path).ok();
            if let Err(error) = shred_file(&path) {
                log::warn!("[vault] no se pudo limpiar {}: {error}", path.display());
            }
        }
    }

    unhide_path(mods_dir).ok();
    if fs::read_dir(mods_dir)
        .map_err(|e| format!("read mods: {e}"))?
        .next()
        .is_none()
    {
        let _ = fs::remove_dir(mods_dir);
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// Shred + limpieza
// ─────────────────────────────────────────────────────────────────────────

/// Sobrescribe con ceros, hace sync y elimina el archivo.
pub fn shred_file(path: &Path) -> std::io::Result<()> {
    let meta = fs::metadata(path)?;
    let len = meta.len();

    {
        let mut f = fs::OpenOptions::new().write(true).open(path)?;
        let zeros = vec![0u8; 64 * 1024];
        let mut written = 0u64;
        while written < len {
            let chunk = std::cmp::min(zeros.len() as u64, len - written) as usize;
            f.write_all(&zeros[..chunk])?;
            written += chunk as u64;
        }
        f.sync_all()?;
    }

    fs::remove_file(path)
}

/// Limpia todos los `.jar` de `mods_dir` de forma segura.
#[cfg(test)]
pub fn cleanup_mods_dir(mods_dir: &Path) -> Result<(), String> {
    if !mods_dir.exists() {
        return Ok(());
    }

    unhide_path(mods_dir).ok();

    let entries = fs::read_dir(mods_dir).map_err(|e| format!("read mods: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("jar") {
            unhide_path(&path).ok();
            if let Err(e) = shred_file(&path) {
                log::warn!("[vault] no se pudo shred {}: {e}", path.display());
            }
        }
    }

    let _ = fs::remove_dir(mods_dir);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// Win32: atributos HIDDEN | SYSTEM
// ─────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn to_wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
pub fn hide_path(path: &Path) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM, GetFileAttributesW, INVALID_FILE_ATTRIBUTES,
        SetFileAttributesW,
    };

    let wide = to_wide(path);
    unsafe {
        let current = GetFileAttributesW(wide.as_ptr());
        if current == INVALID_FILE_ATTRIBUTES {
            return Err(format!("GetFileAttributesW falló para {}", path.display()));
        }
        let new_attrs = current | FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM;
        if SetFileAttributesW(wide.as_ptr(), new_attrs) == 0 {
            return Err(format!("SetFileAttributesW falló para {}", path.display()));
        }
    }
    Ok(())
}

#[cfg(windows)]
pub fn unhide_path(path: &Path) -> Result<(), String> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM, GetFileAttributesW, INVALID_FILE_ATTRIBUTES,
        SetFileAttributesW,
    };

    let wide = to_wide(path);
    unsafe {
        let current = GetFileAttributesW(wide.as_ptr());
        if current == INVALID_FILE_ATTRIBUTES {
            return Ok(());
        }
        let new_attrs = current & !(FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM);
        if SetFileAttributesW(wide.as_ptr(), new_attrs) == 0 {
            return Err(format!("SetFileAttributesW falló para {}", path.display()));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn hide_path(_path: &Path) -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
pub fn unhide_path(_path: &Path) -> Result<(), String> {
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// Sharing lock (Windows): FILE_SHARE_NONE + LockFileEx
// ─────────────────────────────────────────────────────────────────────────

/// Guard que mantiene un descriptor abierto en modo exclusivo y lo cierra en Drop.
pub struct FileLock {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for FileLock {}

impl Drop for FileLock {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(windows)]
pub fn lock_file_exclusive(path: &Path) -> Result<FileLock, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, LOCKFILE_EXCLUSIVE_LOCK, LockFileEx, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    let wide = to_wide(path);

    // dwShareMode = 0 → FILE_SHARE_NONE
    // hTemplateFile = 0 → HANDLE nulo (HANDLE es isize en windows-sys)
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "CreateFileW (exclusivo) falló para {}",
            path.display()
        ));
    }

    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    let ok = unsafe { LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &mut overlapped) };

    if ok == 0 {
        unsafe {
            CloseHandle(handle);
        }
        return Err(format!("LockFileEx falló para {}", path.display()));
    }

    Ok(FileLock { handle })
}

#[cfg(not(windows))]
pub fn lock_file_exclusive(_path: &Path) -> Result<FileLock, String> {
    Ok(FileLock {})
}

// ─────────────────────────────────────────────────────────────────────────
// Redacción de rutas .jar en logs y argumentos JVM
// ─────────────────────────────────────────────────────────────────────────

/// Sustituye cualquier token que contenga `.jar` por `[MOD]`.
pub fn redact_jar_paths(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for token in text.split_inclusive(char::is_whitespace) {
        let trimmed = token.trim_end();
        let lower = trimmed.to_ascii_lowercase();
        if lower.contains(".jar") {
            out.push_str("[MOD]");
            out.extend(token.chars().skip(trimmed.chars().count()));
        } else {
            out.push_str(token);
        }
    }
    out
}

/// Redacta los argumentos JVM: `-Dfoo=C:\...\mod.jar` -> `-Dfoo=[MOD]`
pub fn redact_jvm_args(args: &[String]) -> Vec<String> {
    args.iter().map(|a| redact_jar_paths(a)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_simple_path() {
        let input = "Loading C:\\Users\\x\\mods\\create.jar ...";
        let out = redact_jar_paths(input);
        assert!(!out.to_lowercase().contains("create.jar"));
        assert!(out.contains("[MOD]"));
    }

    #[test]
    fn redact_jvm_arg() {
        let args = vec!["-Dfoo=bar.jar".to_string(), "-Xmx4G".to_string()];
        let out = redact_jvm_args(&args);
        assert_eq!(out[0], "-Dfoo=[MOD]");
        assert_eq!(out[1], "-Xmx4G");
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.jar");
        let enc = dir.path().join("a.jar.enc");
        let dec = dir.path().join("a_out.jar");
        fs::write(&src, b"PK\x03\x04fake-jar-content").unwrap();

        encrypt_file(&src, &enc).unwrap();
        decrypt_file(&enc, &dec).unwrap();

        let original = fs::read(&src).unwrap();
        let restored = fs::read(&dec).unwrap();
        assert_eq!(original, restored);
    }

    #[test]
    fn shred_removes_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("secret.jar");
        fs::write(&p, b"secret data").unwrap();
        shred_file(&p).unwrap();
        assert!(!p.exists());
    }

    #[test]
    fn cleanup_removes_jars() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.jar"), b"a").unwrap();
        fs::write(dir.path().join("b.jar"), b"b").unwrap();
        cleanup_mods_dir(dir.path()).unwrap();
        let remaining: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().collect();
        assert!(remaining.is_empty());
    }
}
