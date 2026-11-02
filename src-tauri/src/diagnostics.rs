// src-tauri/src/diagnostics.rs
//
// Análisis automático de crashes de Minecraft con patrones detectables
// y sugerencias claras para el usuario.

use crate::options::instance_dir;
use crate::types::CrashReportInfo;
use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// Patrones de crash comunes con sus sugerencias.
struct CrashPattern {
    regex: &'static str,
    title: &'static str,
    suggestion: &'static str,
}

const CRASH_PATTERNS: &[CrashPattern] = &[
    CrashPattern {
        regex: r"(?i)OutOfMemoryError|Java heap space|GC overhead limit",
        title: "Falta de Memoria",
        suggestion: "Asigna más memoria RAM en los ajustes del launcher. Si ya está al máximo, cierra otras aplicaciones.",
    },
    CrashPattern {
        regex: r"(?i)UnsupportedClassVersionError|class file has wrong version",
        title: "Incompatibilidad de Java",
        suggestion: "La versión de Java es incorrecta para esta versión de Minecraft. Configura una versión compatible en los ajustes.",
    },
    CrashPattern {
        regex: r"(?i)EXCEPTION_ACCESS_VIOLATION.*\b(ig9ic64|nvoglv64|atio6axx|igxelpicd|nvwgf2um|amdocl64)\.dll",
        title: "Error en Controlador Gráfico",
        suggestion: "Error en el controlador gráfico. Actualiza tus drivers de GPU (NVIDIA, AMD o Intel) a la última versión.",
    },
    CrashPattern {
        regex: r"(?i)Mixin.*prepare failed|Mixin.apply failed|DuplicateModsFoundException",
        title: "Mod Conflictivo",
        suggestion: "Un mod está causando conflictos. Revisa el último mod instalado o usa 'Reparar instancia' para reinstalar el modpack.",
    },
    CrashPattern {
        regex: r"(?i)NoClassDefFoundError|ClassNotFoundException|zip file is empty|invalid LOC header",
        title: "Archivos Corruptos o Faltantes",
        suggestion: "Faltan archivos o están corruptos. Usa 'Reparar instancia' para descargar todos los archivos nuevamente.",
    },
    CrashPattern {
        regex: r"(?i)GLFW error|Pixel format not accelerated|WGL|OpenGL.*(?:error|not supported)",
        title: "Problema con OpenGL",
        suggestion: "Problema con OpenGL/gráficos. Actualiza los drivers de video o reduce la calidad gráfica en las opciones del juego.",
    },
    CrashPattern {
        regex: r"(?i)Could not reserve enough space|Too small (?:initial|maximum) heap|Invalid maximum heap size",
        title: "Configuración de RAM Inválida",
        suggestion: "La configuración de memoria es inválida o mayor que la disponible. Ajusta la RAM en los ajustes del launcher.",
    },
    CrashPattern {
        regex: r"(?i)Unrecognized (?:VM )?option|Could not create the Java Virtual Machine",
        title: "Argumentos de Java Inválidos",
        suggestion: "Los argumentos JVM personalizados contienen errores. Revísalos en los ajustes avanzados o déjalos vacíos.",
    },
];

/// Comando: analyze_crash
///
/// Analiza crash-reports y logs para identificar la causa del crash.
#[tauri::command]
pub async fn analyze_crash(app: AppHandle, instance_id: String) -> Result<CrashReportInfo, String> {
    let dir = instance_dir(&app, &instance_id)?;

    tokio::task::spawn_blocking(move || analyze_crash_blocking(&dir))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn analyze_crash_blocking(instance_dir: &Path) -> Result<CrashReportInfo, String> {
    // 1. Intentar leer crash-reports más reciente
    let crash_dir = instance_dir.join("crash-reports");
    if crash_dir.exists() {
        if let Some((path, content)) = find_latest_crash_report(&crash_dir) {
            return analyze_crash_content(&content, Some(path.to_string_lossy().to_string()));
        }
    }

    // 2. Fallback: leer últimas 200 líneas de latest.log
    let log_path = instance_dir.join("logs").join("latest.log");
    if log_path.exists() {
        let content = read_last_lines(&log_path, 200)?;
        return analyze_crash_content(&content, None);
    }

    // 3. No se encontró información
    Ok(CrashReportInfo {
        title: "Información no disponible".to_string(),
        reason: "No se encontraron reportes de crash ni logs recientes.".to_string(),
        suggestion: "El juego se cerró inesperadamente. Intenta lanzarlo nuevamente y verifica si el problema persiste.".to_string(),
        raw_snippet: String::new(),
        crash_file: None,
    })
}

/// Busca el archivo de crash más reciente en crash-reports/.
fn find_latest_crash_report(crash_dir: &Path) -> Option<(PathBuf, String)> {
    let entries = fs::read_dir(crash_dir).ok()?;
    let mut latest: Option<(PathBuf, std::time::SystemTime)> = None;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("txt") {
            continue;
        }

        let metadata = fs::metadata(&path).ok()?;
        let modified = metadata.modified().ok()?;

        match &latest {
            None => latest = Some((path, modified)),
            Some((_, prev_time)) if modified > *prev_time => {
                latest = Some((path, modified));
            }
            _ => {}
        }
    }

    latest.and_then(|(path, _)| {
        fs::read_to_string(&path)
            .ok()
            .map(|content| (path, content))
    })
}

/// Lee las últimas N líneas de un archivo.
fn read_last_lines(path: &Path, n: usize) -> Result<String, String> {
    let content =
        fs::read_to_string(path).map_err(|e| format!("Error leyendo {}: {}", path.display(), e))?;

    let lines: Vec<&str> = content.lines().collect();
    let start = if lines.len() > n { lines.len() - n } else { 0 };
    Ok(lines[start..].join("\n"))
}

/// Analiza el contenido de un crash report o log.
fn analyze_crash_content(
    content: &str,
    crash_file: Option<String>,
) -> Result<CrashReportInfo, String> {
    // Buscar patrón coincidente
    for pattern in CRASH_PATTERNS {
        let re = Regex::new(pattern.regex)
            .map_err(|e| format!("Error compilando regex '{}': {}", pattern.regex, e))?;

        if re.is_match(content) {
            // Extraer un snippet relevante (contexto alrededor del match)
            let snippet = extract_relevant_snippet(content, pattern.regex);

            // Intentar extraer mod sospechoso si es un mixin conflict
            let reason = if pattern.title == "Mod Conflictivo" {
                extract_mod_name(content)
                    .unwrap_or_else(|| "Un mod está causando conflictos.".to_string())
            } else {
                pattern.title.to_string()
            };

            return Ok(CrashReportInfo {
                title: pattern.title.to_string(),
                reason,
                suggestion: pattern.suggestion.to_string(),
                raw_snippet: snippet,
                crash_file,
            });
        }
    }

    // Ningún patrón coincidió
    Ok(CrashReportInfo {
        title: "Error Desconocido".to_string(),
        reason: "No se pudo identificar la causa específica del crash.".to_string(),
        suggestion:
            "Revisa el log completo para más detalles. Si el problema persiste, contacta a soporte."
                .to_string(),
        raw_snippet: extract_last_error_lines(content, 5),
        crash_file,
    })
}

/// Extrae un snippet de contexto alrededor de la primera coincidencia del regex.
fn extract_relevant_snippet(content: &str, regex_str: &str) -> String {
    let re = match Regex::new(regex_str) {
        Ok(r) => r,
        Err(_) => return content.lines().take(10).collect::<Vec<_>>().join("\n"),
    };

    if let Some(mat) = re.find(content) {
        let lines: Vec<&str> = content.lines().collect();
        let line_start = content[..mat.start()].lines().count();
        let line_end = content[..mat.end()].lines().count();

        let context_start = line_start.saturating_sub(3);
        let context_end = (line_end + 3).min(lines.len());

        lines[context_start..context_end].join("\n")
    } else {
        content.lines().take(10).collect::<Vec<_>>().join("\n")
    }
}

/// Extrae las últimas N líneas de error del contenido.
fn extract_last_error_lines(content: &str, n: usize) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let start = if lines.len() > n { lines.len() - n } else { 0 };
    lines[start..].join("\n")
}

/// Intenta extraer el nombre de un mod conflictivo de errores de mixin.
fn extract_mod_name(content: &str) -> Option<String> {
    // Patrones comunes en errores de mixin
    let patterns = [
        r"Mixin prepare failed for mixin (\[?\w+\]?\.)?(\w+)",
        r"DuplicateModsFoundException.*?:\s*(\w+)",
        r"Exception in thread.*mod\s+(\w+)",
        r"Caused by:\s*\w+\.\w+Exception.*?(\w+\.jar)",
    ];

    for pattern in &patterns {
        if let Ok(re) = Regex::new(pattern) {
            if let Some(caps) = re.captures(content) {
                if let Some(name) = caps.get(2).or_else(|| caps.get(1)) {
                    let mod_name = name.as_str().trim();
                    if !mod_name.is_empty() {
                        return Some(format!("El mod '{}' está causando conflictos.", mod_name));
                    }
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_oom_detection() {
        let content = "java.lang.OutOfMemoryError: Java heap space";
        let result = analyze_crash_content(content, None).unwrap();
        assert_eq!(result.title, "Falta de Memoria");
    }

    #[test]
    fn test_java_version_error() {
        let content = "java.lang.UnsupportedClassVersionError: class file has wrong version";
        let result = analyze_crash_content(content, None).unwrap();
        assert_eq!(result.title, "Incompatibilidad de Java");
    }

    #[test]
    fn test_mixin_error() {
        let content = "Mixin prepare failed for mixin.examplemod.ExampleMixin";
        let result = analyze_crash_content(content, None).unwrap();
        assert_eq!(result.title, "Mod Conflictivo");
        assert!(result.reason.contains("mod"));
    }

    #[test]
    fn test_extract_mod_name() {
        let content = "Mixin prepare failed for mixin.examplemod.ExampleMixin";
        let name = extract_mod_name(content);
        assert!(name.is_some());
    }
}
