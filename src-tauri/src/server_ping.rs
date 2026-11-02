// src-tauri/src/server_ping.rs
//
// Implementación del protocolo Minecraft Server List Ping (SLP) moderno.
// Referencia: https://wiki.vg/Server_List_Ping
//
// Flujo:
//   TCP connect → Handshake(0x00) → Status Request(0x00)
//     → Status Response(0x00) → Ping(0x01) → Pong(0x01)
//
// La latencia reportada es la del round-trip del par Ping/Pong (más precisa
// que medir solo el tiempo de conexión + handshake, que incluye DNS/TLS
// irrelevantes para lo que el usuario percibe como "ping de juego").

use crate::types::ServerStatus;
use serde::{Deserialize, Serialize};
use std::io;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

/// Protocol version declarada en el handshake.
/// Cualquier valor >= 0 es aceptado para el status; usamos 765 (1.20.4)
/// como valor "moderno" por defecto.
const PROTOCOL_VERSION: i32 = 765;

/// Timeout total por defecto para todo el ciclo SLP.
const DEFAULT_TIMEOUT_MS: u64 = 5000;

/// Límite de bytes para el JSON de status.
/// El protocolo permite hasta 32767 × 4 bytes; usamos 128 KiB como tope
/// de seguridad para evitar DoS desde servidores maliciosos.
const MAX_STATUS_JSON_BYTES: usize = 128 * 1024;

/// Payload arbitrario del paquete Ping. El servidor lo reenvía intacto
/// en el Pong, así que cualquier valor sirve.
const PING_PAYLOAD: i64 = 0x0123_4567_89AB_CDEF;

// ─────────────────────────────────────────────────────────────────────────
// Tipos de respuesta (contrato IPC)
// ─────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPingResult {
    pub success: bool,
    /// Host:puerto normalizado (ej. "play.example.com:25565")
    pub host: String,
    /// Latencia del round-trip Ping/Pong en milisegundos.
    /// Si el servidor no responde al Ping, se usa el tiempo total hasta
    /// la Status Response como fallback.
    pub latency_ms: u64,
    pub version: ServerVersion,
    pub players: ServerPlayers,
    /// MOTD completo (concatenado si tiene formato estructurado).
    pub motd: String,
    /// Favicon como Data URL (`data:image/png;base64,...`). Puede ser grande.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerVersion {
    /// Ej: "Paper 1.20.4", "Vanilla", "Purpur 1.21"
    pub name: String,
    /// Protocol number (765 = 1.20.4, 767 = 1.21, etc.)
    pub protocol: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPlayers {
    pub online: u32,
    pub max: u32,
}

// ─────────────────────────────────────────────────────────────────────────
// Comando IPC
// ─────────────────────────────────────────────────────────────────────────

/// Comando: server_ping
///
/// Ejemplo desde el frontend:
///   await invoke("server_ping", { host: "play.example.com", port: 25565 });
#[tauri::command]
pub async fn server_ping(host: String, port: u16) -> Result<ServerPingResult, String> {
    if host.is_empty() {
        return Err("host no puede estar vacío".into());
    }
    if host.len() > 255 {
        return Err("host demasiado largo".into());
    }

    let addr = format!("{}:{}", host, port);

    match timeout(
        Duration::from_millis(DEFAULT_TIMEOUT_MS),
        inner_ping(&host, port),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(format!(
            "Timeout de {}ms excedido al pingear {}",
            DEFAULT_TIMEOUT_MS, addr
        )),
    }
}

/// Comando: get_server_status
///
/// Versión simplificada que retorna ServerStatus para integración con la UI.
#[tauri::command]
pub async fn get_server_status(host: String, port: u16) -> Result<ServerStatus, String> {
    let result = server_ping(host, port).await?;
    Ok(ServerStatus {
        online: result.success,
        ping_ms: result.latency_ms as u32,
        players_online: result.players.online,
        players_max: result.players.max,
        motd: result.motd,
        version: result.version.name,
    })
}

// ─────────────────────────────────────────────────────────────────────────
// Implementación interna
// ─────────────────────────────────────────────────────────────────────────

async fn inner_ping(host: &str, port: u16) -> Result<ServerPingResult, String> {
    let addr = format!("{}:{}", host, port);
    let connect_start = Instant::now();

    // 1) Conectar
    let stream = TcpStream::connect(&addr)
        .await
        .map_err(|e| format!("No se pudo conectar a {}: {}", addr, e))?;

    // Importante para mediciones de latencia: desactivar Nagle.
    stream.set_nodelay(true).ok();

    let (mut reader, mut writer) = stream.into_split();

    // 2) Handshake (0x00)
    let mut hs_data = Vec::with_capacity(64);
    write_varint(0x00, &mut hs_data); // packet ID
    write_varint(PROTOCOL_VERSION, &mut hs_data); // protocol version
    write_string(host, &mut hs_data); // server address
    hs_data.extend_from_slice(&port.to_be_bytes()); // server port (u16 BE)
    write_varint(1, &mut hs_data); // next state = status

    let mut hs_packet = Vec::with_capacity(hs_data.len() + 4);
    write_varint(hs_data.len() as i32, &mut hs_packet);
    hs_packet.extend_from_slice(&hs_data);

    writer
        .write_all(&hs_packet)
        .await
        .map_err(|e| format!("Error enviando handshake: {}", e))?;

    // 3) Status Request (0x00 sin campos) → [len=0x01][id=0x00]
    writer
        .write_all(&[0x01, 0x00])
        .await
        .map_err(|e| format!("Error enviando status request: {}", e))?;

    // 4) Leer Status Response
    let _len = read_varint(&mut reader)
        .await
        .map_err(|e| format!("Error leyendo longitud de respuesta: {}", e))?;
    let packet_id = read_varint(&mut reader)
        .await
        .map_err(|e| format!("Error leyendo packet ID de respuesta: {}", e))?;
    if packet_id != 0x00 {
        return Err(format!(
            "Packet ID inesperado en Status Response: 0x{:02X}",
            packet_id
        ));
    }
    let json_str = read_string(&mut reader)
        .await
        .map_err(|e| format!("Error leyendo JSON de status: {}", e))?;

    let total_to_status = connect_start.elapsed();

    // 5) Ping/Pong para medir latencia real
    let ping_start = Instant::now();

    let mut ping_data = Vec::with_capacity(9);
    write_varint(0x01, &mut ping_data);
    ping_data.extend_from_slice(&PING_PAYLOAD.to_be_bytes());

    let mut ping_packet = Vec::with_capacity(ping_data.len() + 1);
    write_varint(ping_data.len() as i32, &mut ping_packet);
    ping_packet.extend_from_slice(&ping_data);

    let latency =
        match send_ping_read_pong(&mut reader, &mut writer, &ping_packet, ping_start).await {
            Ok(d) => d,
            Err(_) => {
                // Fallback: servidores que cierran tras Status Response
                total_to_status
            }
        };

    // 6) Parsear JSON
    let parsed: serde_json::Value =
        serde_json::from_str(&json_str).map_err(|e| format!("JSON de status inválido: {}", e))?;

    let version_node = parsed
        .get("version")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let version_name = version_node
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let version_protocol = version_node
        .get("protocol")
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as i32;

    let players_node = parsed
        .get("players")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let players_online = players_node
        .get("online")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let players_max = players_node
        .get("max")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;

    let motd = parsed
        .get("description")
        .map(extract_motd)
        .unwrap_or_default();

    let favicon = parsed
        .get("favicon")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(ServerPingResult {
        success: true,
        host: addr,
        latency_ms: latency.as_millis() as u64,
        version: ServerVersion {
            name: version_name,
            protocol: version_protocol,
        },
        players: ServerPlayers {
            online: players_online,
            max: players_max,
        },
        motd,
        favicon,
    })
}

async fn send_ping_read_pong<R, W>(
    reader: &mut R,
    writer: &mut W,
    ping_packet: &[u8],
    ping_start: Instant,
) -> Result<Duration, String>
where
    R: AsyncReadExt + Unpin,
    W: AsyncWriteExt + Unpin,
{
    writer
        .write_all(ping_packet)
        .await
        .map_err(|e| format!("Error enviando ping: {}", e))?;

    let _len = read_varint(reader)
        .await
        .map_err(|e| format!("Error leyendo longitud de pong: {}", e))?;
    let id = read_varint(reader)
        .await
        .map_err(|e| format!("Error leyendo packet ID de pong: {}", e))?;
    if id != 0x01 {
        return Err(format!("Packet ID de Pong inesperado: 0x{:02X}", id));
    }

    let mut payload = [0u8; 8];
    reader
        .read_exact(&mut payload)
        .await
        .map_err(|e| format!("Error leyendo payload de pong: {}", e))?;

    // (Opcional) validar payload == PING_PAYLOAD
    Ok(ping_start.elapsed())
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers del protocolo (VarInt / String / MOTD)
// ─────────────────────────────────────────────────────────────────────────

/// Serializa un VarInt (int32) en formato de protocolo Minecraft.
fn write_varint(value: i32, buf: &mut Vec<u8>) {
    let mut val = value as u32;
    loop {
        let mut byte = (val & 0x7F) as u8;
        val >>= 7;
        if val != 0 {
            byte |= 0x80;
        }
        buf.push(byte);
        if val == 0 {
            return;
        }
    }
}

/// Lee un VarInt (máx. 5 bytes) desde un reader asíncrono.
async fn read_varint<R: AsyncReadExt + Unpin>(reader: &mut R) -> io::Result<i32> {
    let mut result: u32 = 0;
    let mut num_read = 0;

    loop {
        let byte = reader.read_u8().await?;
        result |= ((byte & 0x7F) as u32) << (7 * num_read);
        num_read += 1;

        if byte & 0x80 == 0 {
            break;
        }
        if num_read >= 5 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "VarInt demasiado largo (>5 bytes)",
            ));
        }
    }
    Ok(result as i32)
}

/// Serializa un String (VarInt length + UTF-8 bytes).
fn write_string(s: &str, buf: &mut Vec<u8>) {
    write_varint(s.len() as i32, buf);
    buf.extend_from_slice(s.as_bytes());
}

/// Lee un String (VarInt length + UTF-8) con tope de seguridad.
async fn read_string<R: AsyncReadExt + Unpin>(reader: &mut R) -> io::Result<String> {
    let len = read_varint(reader).await?;
    if len < 0 || (len as usize) > MAX_STATUS_JSON_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Longitud de string inválida: {}", len),
        ));
    }
    let mut buf = vec![0u8; len as usize];
    reader.read_exact(&mut buf).await?;
    String::from_utf8(buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Extrae el texto plano de un MOTD. Soporta:
///   - String directo: "Welcome!"
///   - Objeto chat: { "text": "Welcome", "extra": [...] }
///   - Array de componentes
fn extract_motd(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(obj) => {
            let mut out = String::new();
            if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                out.push_str(text);
            }
            if let Some(extra) = obj.get("extra").and_then(|v| v.as_array()) {
                for item in extra {
                    out.push_str(&extract_motd(item));
                }
            }
            out
        }
        serde_json::Value::Array(arr) => arr.iter().map(extract_motd).collect::<Vec<_>>().join(""),
        _ => String::new(),
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Tests unitarios del protocolo (sin red)
// ─────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_encoding_matches_spec() {
        // Casos de wiki.vg/Protocol#VarInt_and_VarLong
        let cases: &[(i32, &[u8])] = &[
            (0, &[0x00]),
            (1, &[0x01]),
            (127, &[0x7F]),
            (128, &[0x80, 0x01]),
            (255, &[0xFF, 0x01]),
            (25565, &[0xDD, 0xC7, 0x01]),
            (2_097_151, &[0xFF, 0xFF, 0x7F]),
            (2_147_483_647, &[0xFF, 0xFF, 0xFF, 0xFF, 0x07]),
            (-1, &[0xFF, 0xFF, 0xFF, 0xFF, 0x0F]),
            (-2_147_483_648, &[0x80, 0x80, 0x80, 0x80, 0x08]),
        ];

        for (value, expected) in cases {
            let mut buf = Vec::new();
            write_varint(*value, &mut buf);
            assert_eq!(&buf, expected, "encode failed for {}", value);
        }
    }

    #[tokio::test]
    async fn varint_roundtrip() {
        for value in [
            0i32,
            1,
            127,
            128,
            255,
            25565,
            2_097_151,
            2_147_483_647,
            -1,
            -2_147_483_648,
        ] {
            let mut buf = Vec::new();
            write_varint(value, &mut buf);
            let mut cursor = &buf[..];
            let decoded = read_varint(&mut cursor).await.unwrap();
            assert_eq!(decoded, value);
        }
    }

    #[tokio::test]
    async fn varint_rejects_oversized() {
        // 6 bytes con continuation bit → debe fallar
        let bad = [0x80u8, 0x80, 0x80, 0x80, 0x80, 0x80];
        let mut cursor = &bad[..];
        assert!(read_varint(&mut cursor).await.is_err());
    }

    #[tokio::test]
    async fn string_roundtrip() {
        let s = "play.example.com";
        let mut buf = Vec::new();
        write_string(s, &mut buf);
        let mut cursor = &buf[..];
        let decoded = read_string(&mut cursor).await.unwrap();
        assert_eq!(decoded, s);
    }

    #[test]
    fn motd_plain_string() {
        let v = serde_json::json!("Hello world");
        assert_eq!(extract_motd(&v), "Hello world");
    }

    #[test]
    fn motd_chat_object() {
        let v = serde_json::json!({
            "text": "Welcome ",
            "extra": [
                { "text": "to ", "color": "gold" },
                "the server"
            ]
        });
        assert_eq!(extract_motd(&v), "Welcome to the server");
    }

    #[test]
    fn motd_array() {
        let v = serde_json::json!(["Line 1\n", "Line 2"]);
        assert_eq!(extract_motd(&v), "Line 1\nLine 2");
    }
}
