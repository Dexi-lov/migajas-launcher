const electronObj = require('electron');
const app = electronObj.app;
const BrowserWindow = electronObj.BrowserWindow;
const ipcMain = electronObj.ipcMain;
const shell = electronObj.shell;
const dialog = electronObj.dialog;
const safeStorage = electronObj.safeStorage;
const { Client } = require('minecraft-launcher-core');
const { Auth, tokenUtils } = require('msmc');
const path = require('path');
const fs = require('fs');
const os = require('os');
const AdmZip = require('adm-zip');
const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util = require('util');
const { pipeline } = require('stream/promises');
// IMPORTANTE (seguridad): se usa execFile en vez de exec. exec() lanza el
// comando a través de una shell, así que cualquier ruta que contenga
// comillas, `&&`, `;`, backticks, etc. podía inyectar comandos arbitrarios
// si ese texto salía (directa o indirectamente) de algo que llega por IPC
// desde el renderer (p.ej. un "id" de instancia). execFile no pasa por una
// shell y recibe los argumentos como array, así que ese vector desaparece.
const execFileAsync = util.promisify(execFile);

// --- SETUP ---
let DiscordRPC, rpcClient, tieneDiscord = false;
try { DiscordRPC = require('discord-rpc'); tieneDiscord = true; } catch (e) { }
const launcher = new Client();
let win, splash;

// INSTANCIA ÚNICA. Al arrancar el juego el launcher oculta su ventana; si el jugador vuelve a
// pulsar el icono para "recuperarlo" se abría un SEGUNDO launcher, y ese segundo launcher ejecuta
// limpiarModsHuerfanosAlIniciar() (borra mods/ de las instancias) justo debajo de la partida que
// sigue en marcha: jars borrados o bloqueados a mitad de juego = crash. Con el lock, el segundo
// intento solo trae al frente la ventana del launcher que ya existe.
const instanciaUnica = app.requestSingleInstanceLock();
if (!instanciaUnica) app.quit();
app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show(); win.focus();
    }
});

// Un error no capturado en el proceso principal mostraba el diálogo de Electron y podía dejar
// al launcher (y su control sobre la partida) en un estado roto en pleno juego. Se registra y se sigue.
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
    try { escribirLog(`uncaughtException: ${(err && err.stack) || err}`); } catch (e) { }
});
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
    try { escribirLog(`unhandledRejection: ${(reason && reason.stack) || reason}`); } catch (e) { }
});
// Bandera global: true mientras Minecraft está realmente corriendo.
// Se usa para impedir que el launcher se cierre de golpe (por la X de la
// ventana, Alt+F4, o el botón de cerrar de la UI) mientras el juego está
// abierto, ya que eso podía cortar el proceso de Minecraft a mitad de
// partida y generar problemas (partidas corruptas, mods a medio limpiar, etc).
let jugando = false;
// true mientras se prepara el lanzamiento (Java, modpack, mods). Evita lanzar dos partidas a la vez.
let lanzando = false;
const clientId = '1411570545190899822';

// =========================================================
// RUTAS DE DATOS
// =========================================================
let GAME_ROOT = '';
let INSTANCES_FILE = '';
let AUTH_FILE = '';
let LOG_FILE = '';

// --- AUTOLIMPIEZA DE ARRANQUE ---
function initRoots() {
    GAME_ROOT = path.join(app.getPath('userData'), '.migajas_mc');
    INSTANCES_FILE = path.join(app.getPath('userData'), 'custom_instances.json');
    AUTH_FILE = path.join(app.getPath('userData'), 'session.dat');
    LOG_FILE = path.join(app.getPath('userData'), 'launcher.log');
    try { if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (e) { }
    try {
        if (fs.existsSync(GAME_ROOT)) {
            const stats = fs.statSync(GAME_ROOT);
            if (!stats.isDirectory()) fs.unlinkSync(GAME_ROOT);
        }
        if (!fs.existsSync(GAME_ROOT)) fs.mkdirSync(GAME_ROOT, { recursive: true });
    } catch (e) { console.error("Error validando root:", e); }
}

// =========================================================
// VALIDACIÓN DE IDs DE INSTANCIA (anti path-traversal / anti-inyección)
// =========================================================
// Varios canales IPC reciben un "id" desde el renderer y lo usan para
// construir una ruta en disco (instances/<id>, .vault/<id>...), y algunas
// de esas rutas terminan pasando por operaciones destructivas (borrar-instancia
// hace un rm recursivo). Sin validar, un id como "../../../../AppData" permite
// escapar de GAME_ROOT y borrar o leer cosas fuera del launcher. Se exige un
// charset seguro y, además, se comprueba que la ruta ya resuelta siga
// literalmente dentro de la carpeta esperada (defensa en profundidad, por si
// el primer filtro se saltara algún caso raro).
function idSeguro(id) {
    const limpio = String(id ?? 'default');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(limpio)) return null;
    return limpio;
}

function rutaDentroDe(base, ...partes) {
    const baseAbs = path.resolve(base) + path.sep;
    const destino = path.resolve(base, ...partes);
    if (!destino.startsWith(baseAbs)) return null;
    return destino;
}

function rutaInstanciaSegura(id) {
    const seguro = idSeguro(id);
    if (!seguro) return null;
    return rutaDentroDe(path.join(GAME_ROOT, "instances"), seguro);
}

// =========================================================
// ESTABILIDAD DEL JUEGO: Java, RAM, argumentos JVM y diagnóstico
// =========================================================
// <<helpers-start>>

// Qué Java exige cada versión de Minecraft.
// Antes: parseFloat(version.substring(0, 4)), que se equivoca con:
//   - 1.7 / 1.8 / 1.9 ("1.8." -> 1.8 >= 1.21 -> daba Java 21; necesitan 8)
//   - 1.20.5 / 1.20.6 (necesitan Java 21, daba 17)
//   - versionado nuevo 26.x (necesita Java 25, daba 21)
// Un Java demasiado viejo o demasiado nuevo = el juego se cierra al arrancar.
function javaRequeridoPara(mcVersion) {
    const m = String(mcVersion || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!m) return '21';
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10), c = parseInt(m[3] || '0', 10);
    if (a >= 26) return '25';
    if (a === 1) {
        if (b >= 21 || (b === 20 && c >= 5)) return '21';
        if (b >= 17) return '17'; // 1.17 pide 16; 17 también sirve
        return '8';
    }
    return '21';
}

// Convierte lo que mande la UI ("4G", "4096", 4, "4096M", "4 GB") a MB.
function aMegas(valor) {
    const m = String(valor ?? '').trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*(g|gb|m|mb)?$/);
    if (!m) return null;
    const n = parseFloat(m[1].replace(',', '.'));
    if (!isFinite(n) || n <= 0) return null;
    const u = m[2];
    if (u === 'g' || u === 'gb') return Math.round(n * 1024);
    if (u === 'm' || u === 'mb') return Math.round(n);
    return Math.round(n <= 64 ? n * 1024 : n); // sin unidad: <=64 se lee como GB, si no como MB
}

// Calcula -Xmx / -Xms seguros. Antes se pasaba la RAM tal cual y min era "2G" fijo:
//  - si la UI mandaba un número sin unidad, MCLC armaba "-Xmx4" (4 BYTES) y la JVM no arrancaba;
//  - nada limitaba la RAM a la que realmente tiene el equipo (pedir 8G en un PC de 8G = swap/OOM);
//  - con max < 2G el -Xms2G fijo era mayor que -Xmx y la JVM abortaba.
function calcularMemoria(ramPedida, totalMB = os.totalmem() / 1048576, libreMB = os.freemem() / 1048576) {
    const MINIMO = 2048;
    const avisos = [];
    let max = aMegas(ramPedida);
    if (max === null) { max = 4096; avisos.push(`RAM "${ramPedida}" no es válida; se usan 4096 MB.`); }
    const techo = Math.max(MINIMO, Math.floor(totalMB * 0.75)); // deja 25% al sistema
    if (max > techo) { avisos.push(`Se pidieron ${max} MB pero el equipo solo tiene ${Math.round(totalMB)} MB; se limita a ${techo} MB.`); max = techo; }
    if (max < MINIMO) { avisos.push(`Un modpack necesita al menos ${MINIMO} MB; se sube desde ${max} MB.`); max = MINIMO; }
    // -Xms: memoria que se reserva de golpe al arrancar. Nunca más que max ni que ~60% de la RAM libre.
    const min = Math.max(512, Math.min(2048, max, Math.floor(libreMB * 0.6)));
    return { max, min, avisos };
}

// Argumentos JVM que escribe el jugador. Se descarta lo que rompe el arranque o abre puertas:
//  - Xmx/Xms (ya los controla calcularMemoria; duplicados = comportamiento indefinido)
//  - tokens sin "-" (la JVM los tomaría como la clase main)
//  - -cp/-jar/-javaagent/-agentlib/... y OnError/OnOutOfMemoryError (ejecutan código/comandos)
//  - más de un recolector de basura (la JVM aborta con "Conflicting collector combinations")
const JVM_PROHIBIDOS = /^(?:-Xm[sx]|-Xss|-cp$|-classpath$|--class-path|-jar$|-javaagent|-agentlib|-agentpath|-Xbootclasspath|-Djava\.library\.path|-XX:OnError|-XX:OnOutOfMemoryError|-XX:Flags=|-XX:VMOptionsFile)/i;
const JVM_GC = /^-XX:\+Use(?:Serial|Parallel|ParNew|ConcMarkSweep|G1|Z|Shenandoah|Epsilon)GC$/;
function sanitizarJvmArgs(texto) {
    const args = [], ignorados = [];
    let hayGc = false;
    for (const a of String(texto || '').split(/\s+/).filter(Boolean).slice(0, 40)) {
        if (!a.startsWith('-') || a.length > 200 || JVM_PROHIBIDOS.test(a)) { ignorados.push(a); continue; }
        if (JVM_GC.test(a)) { if (hayGc) { ignorados.push(a); continue; } hayGc = true; }
        args.push(a);
    }
    // Con flags del jugador, que una opción obsoleta/desconocida para ESTA versión de Java
    // se ignore en vez de abortar el arranque ("Unrecognized VM option").
    if (args.length) args.unshift('-XX:+IgnoreUnrecognizedVMOptions');
    return { args, ignorados };
}

function redactar(texto) {
    return String(texto).replace(/(--accessToken\s+)\S+/g, '$1***');
}

async function renombrarConReintentos(origen, destino) {
    for (let i = 0; ; i++) {
        try { await fs.promises.rename(origen, destino); return; }
        catch (e) {
            if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
            await new Promise(r => setTimeout(r, 500)); // antivirus escaneando el archivo recién creado
        }
    }
}

// --- Marca de "hay un Minecraft vivo en esta instancia" ---
// Evita que un launcher recién abierto (o reiniciado tras cerrarse el anterior) borre mods/
// debajo de una partida que sigue en marcha, o lance una segunda partida sobre la misma carpeta.
const MARCA_JUEGO = '.migajas_running.json';
function procesoVivo(pid) {
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; } // EPERM = existe pero es de otro usuario
}
// Nombre del ejecutable de un PID. Se usa para que la marca no se pueda falsificar apuntando a un
// proceso cualquiera (p. ej. el bloc de notas) y así evitar que el barrido borre mods/ en claro.
async function nombreProceso(pid) {
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000 });
            return (stdout.split('","')[0] || '').replace(/"/g, '').trim().toLowerCase();
        }
        const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 8000 });
        return path.basename(stdout.trim()).toLowerCase();
    } catch (e) { return ''; }
}
// Línea de comandos completa de un PID (en Windows, PowerShell/CIM; en mac/Linux, ps).
async function lineaDeComando(pid) {
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { windowsHide: true, timeout: 12000 });
            return stdout.trim();
        }
        const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'args='], { timeout: 8000 });
        return stdout.trim();
    } catch (e) { return ''; }
}
const normRuta = (s) => String(s).toLowerCase().replace(/\\/g, '/');
// Devuelve el PID si hay un Minecraft REAL vivo de ESTA instancia. Se comprueba que el PID sea un java
// y que su línea de comandos apunte a la carpeta de la instancia: así la marca no se puede falsificar
// con un proceso cualquiera, y un PID reciclado por otro java (Windows los reutiliza enseguida) no
// bloquea al jugador para siempre con "ya hay una partida en ejecución".
async function juegoActivoEn(instancePath) {
    try {
        const marca = path.join(instancePath, MARCA_JUEGO);
        const st = fs.statSync(marca);
        if (st.mtimeMs < Date.now() - os.uptime() * 1000) return null; // anterior al último arranque del PC: PID reciclado
        const d = JSON.parse(fs.readFileSync(marca, 'utf8'));
        if (!Number.isInteger(d.pid) || !procesoVivo(d.pid)) return null;
        if (!/^javaw?(\.exe)?$/.test(await nombreProceso(d.pid))) return null;
        const cl = await lineaDeComando(d.pid);
        if (cl && !normRuta(cl).includes(normRuta(instancePath))) return null; // es otro java, no esta instancia
        return d.pid;
    } catch (e) { return null; }
}
function marcarJuegoActivo(instancePath, pid) {
    try { fs.writeFileSync(path.join(instancePath, MARCA_JUEGO), JSON.stringify({ pid })); } catch (e) { }
}
function limpiarMarcaJuego(instancePath) {
    try { fs.unlinkSync(path.join(instancePath, MARCA_JUEGO)); } catch (e) { }
}

// --- Diagnóstico de crashes ---
// Convierte la salida del juego en una causa legible y la deja en launcher.log para soporte.
const PATRONES_CRASH = [
    [/UnsupportedClassVersionError|more recent version of the Java Runtime/i, 'Versión de Java incompatible con el juego o los mods.'],
    [/OutOfMemoryError|GC overhead limit|Java heap space/i, 'Se quedó sin memoria: sube la RAM asignada (si el equipo lo permite).'],
    [/Could not reserve enough space|Too small (?:initial|maximum) heap|Invalid maximum heap size|Initial heap size set to a larger/i, 'Configuración de RAM inválida o mayor que la disponible.'],
    [/Unrecognized (?:VM )?option|Could not create the Java Virtual Machine|Could not find or load main class/i, 'Argumentos de Java inválidos o Java dañado.'],
    [/NoClassDefFoundError|ClassNotFoundException|ZipException|zip file is empty|invalid LOC header|error in opening zip file/i, 'Faltan archivos o están corruptos: usa "Reparar instancia".'],
    [/EXCEPTION_ACCESS_VIOLATION|SIGSEGV|hs_err_pid/i, 'Fallo nativo de la JVM o del driver de video: actualiza los drivers gráficos.'],
    [/GLFW error|Pixel format not accelerated|WGL|OpenGL.*(?:error|not supported)/i, 'Problema con OpenGL/gráficos: actualiza los drivers de video.']
];
function diagnosticarCrash(texto) {
    const t = String(texto || '');
    return PATRONES_CRASH.filter(([re]) => re.test(t)).map(([, msg]) => msg);
}

async function resumenCrashReport(instancePath, desdeMs) {
    try {
        const dir = path.join(instancePath, 'crash-reports');
        let mejor = null;
        for (const f of await fs.promises.readdir(dir)) {
            if (!f.endsWith('.txt')) continue;
            const st = await fs.promises.stat(path.join(dir, f));
            if (st.mtimeMs >= desdeMs - 5000 && (!mejor || st.mtimeMs > mejor.t)) mejor = { f, t: st.mtimeMs };
        }
        if (!mejor) return null;
        const txt = (await fs.promises.readFile(path.join(dir, mejor.f), 'utf8')).slice(0, 12000);
        const desc = (txt.match(/^Description:\s*(.+)$/m) || [])[1] || '';
        const exc = txt.split(/\r?\n/).find(l => /^[\w.$]+(?:Exception|Error)\b/.test(l)) || '';
        return { archivo: mejor.f, desc: desc.trim(), exc: exc.trim().slice(0, 200) };
    } catch (e) { return null; }
}

async function construirInfoCrash(code, cola, instancePath, desdeMs, ultimoFallo) {
    const partes = [`El juego se cerró inesperadamente (Código ${code}).`];
    const diag = diagnosticarCrash(cola.join('\n') + '\n' + (ultimoFallo || ''));
    if (diag.length) partes.push('Posible causa: ' + diag.join(' / '));
    const cr = await resumenCrashReport(instancePath, desdeMs);
    if (cr) partes.push(`Reporte ${cr.archivo}${cr.desc ? ': ' + cr.desc : ''}${cr.exc ? '\n' + cr.exc : ''}`);
    else if (ultimoFallo) partes.push(ultimoFallo);
    if (cola.length) escribirLog('--- Últimas líneas del juego antes del cierre ---\n' + cola.slice(-80).join('\n') + '\n--- fin ---');
    partes.push('Si se repite, envía launcher.log a soporte.');
    return partes.join('\n');
}

// Busca un perfil de Fabric ya instalado en la instancia para ese Minecraft (el pack suele traerlo).
function fabricInstalado(instancePath, mc) {
    try {
        const dir = path.join(instancePath, 'versions');
        const re = new RegExp('^fabric-loader-[0-9][^-]*-' + String(mc).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
        return fs.readdirSync(dir)
            .filter(d => re.test(d) && fs.existsSync(path.join(dir, d, d + '.json')))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() || null;
    } catch (e) { return null; }
}
// <<helpers-end>>

// --- UTILS ---
// Todo lo que pasa por log()/enviarError() también queda en launcher.log (userData),
// así un jugador con el launcher "pegado" puede mandar el archivo y se ve en qué fase se quedó.
function escribirLog(linea) {
    if (!LOG_FILE) return;
    fs.appendFile(LOG_FILE, `[${new Date().toISOString()}] ${linea}\n`, () => { });
}

function log(msg) {
    console.log(`[SISTEMA]: ${msg}`);
    escribirLog(msg);
    if (win && !win.isDestroyed()) win.webContents.send('consola', msg);
}

function enviarError(titulo, mensaje) {
    escribirLog(`ERROR · ${titulo}: ${mensaje}`);
    if (win && !win.isDestroyed()) {
        win.webContents.send('error-lanzamiento', { titulo, mensaje });
        win.webContents.send('reset-ui');
    }
}

function enviarProgreso(tipo, task, total, extra = {}) {
    if (win && !win.isDestroyed()) {
        win.webContents.send('progreso', { type: tipo, task, total, ...extra });
    }
}

function updateDiscord(estado, detalles) {
    if (!tieneDiscord || !rpcClient) return;
    rpcClient.setActivity({
        details: detalles, state: estado,
        largeImageKey: 'logo_grande', largeImageText: 'Migajas', instance: false
    }).catch(() => { });
}

// --- MOTOR DE DESCARGAS (con velocidad MB/s) ---
// Si pasan tantos ms sin recibir NI UN byte, se da la descarga por colgada.
// Antes no había ninguna comprobación así: el timeout de axios solo cubre hasta
// recibir las cabeceras, así que con el wifi saturado de un evento la descarga podía
// quedarse parada para siempre sin dar error y la UI se quedaba en "Lanzando".
const DESCARGA_SIN_DATOS_MS = 30000;

async function descargarUnaVez(urlFinal, destino) {
    const parcial = destino + '.part';
    await fs.promises.unlink(parcial).catch(() => { });

    const response = await axios({ url: urlFinal, method: 'GET', responseType: 'stream', maxRedirects: 5, timeout: 60000 });
    const tipo = String(response.headers['content-type'] || '');
    if (tipo.includes('text/html')) {
        response.data.destroy();
        throw new Error('El enlace devolvió una página web en vez del archivo (¿enlace caído o límite de tráfico del hosting?).');
    }

    const total = parseInt(response.headers['content-length'], 10) || 0;
    const fileName = path.basename(destino);
    // El writer se crea DESPUÉS de tener respuesta: así si axios falla no queda un handle abierto.
    const writer = fs.createWriteStream(parcial);

    let downloaded = 0, lastUpd = 0, lastBytes = 0, lastTime = Date.now(), lastLog = 0;
    let ultimoDato = Date.now();
    const vigilante = setInterval(() => {
        if (Date.now() - ultimoDato > DESCARGA_SIN_DATOS_MS) {
            response.data.destroy(new Error(`Descarga detenida: sin datos desde hace ${DESCARGA_SIN_DATOS_MS / 1000} s.`));
        }
    }, 5000);

    response.data.on('data', (c) => {
        downloaded += c.length;
        const now = Date.now();
        ultimoDato = now;
        if (total) {
            if (now - lastUpd > 200) {
                const elapsed = (now - lastTime) / 1000;
                const speed = elapsed > 0 ? ((downloaded - lastBytes) / elapsed / 1024 / 1024).toFixed(1) : '0.0';
                lastBytes = downloaded; lastTime = now; lastUpd = now;
                enviarProgreso('download', downloaded, total, { speed, file: fileName });
            }
        } else if (now - lastLog > 3000) {
            // Sin content-length no se puede calcular un %, pero al menos se ve que avanza.
            lastLog = now;
            log(`Descargando ${fileName}: ${(downloaded / 1024 / 1024).toFixed(1)} MB...`);
        }
    });

    try {
        await pipeline(response.data, writer); // cierra/destruye ambos streams si cualquiera falla
    } catch (err) {
        await fs.promises.unlink(parcial).catch(() => { });
        throw err;
    } finally {
        clearInterval(vigilante);
    }

    // .part -> nombre final solo cuando está completo (así un corte a mitad no deja un
    // archivo a medias que luego se confunda con uno bueno, p. ej. el installer de Forge).
    // El antivirus puede tener el archivo bloqueado un instante: se reintenta.
    for (let i = 0; ; i++) {
        try { await fs.promises.rename(parcial, destino); break; }
        catch (e) {
            if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
            await new Promise(r => setTimeout(r, 400));
        }
    }
    await new Promise(r => setTimeout(r, 500));
}

async function descargarArchivo(url, destino, intentos = 3) {
    if (!url) throw new Error("URL vacía");
    let urlFinal = url;
    if (url.includes('dropbox.com'))
        urlFinal = url.replace("www.dropbox.com", "dl.dropboxusercontent.com")
            .replace("?dl=1", "").replace("&dl=1", "");

    const dir = path.dirname(destino);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let ultimoError;
    for (let n = 1; n <= intentos; n++) {
        try { await descargarUnaVez(urlFinal, destino); return; }
        catch (e) {
            ultimoError = e;
            const status = e.response && e.response.status;
            log(`⚠️ Descarga fallida (intento ${n}/${intentos})${status ? ' [HTTP ' + status + ']' : ''}: ${e.message}`);
            // Un 404/403/etc. no se arregla reintentando (salvo 408 y 429).
            if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) break;
            if (n < intentos) await new Promise(r => setTimeout(r, 2000 * n));
        }
    }
    throw ultimoError;
}

async function moverContenidoCarpeta(origen, destino) {
    if (!fs.existsSync(destino)) await fs.promises.mkdir(destino, { recursive: true });
    const items = await fs.promises.readdir(origen);
    // Procesar en paralelo (antes era secuencial: archivo por archivo).
    // Con packs de miles de archivos esto reduce el tiempo de forma notable.
    await Promise.all(items.map(async (el) => {
        const src = path.join(origen, el);
        const dest = path.join(destino, el);
        const stat = await fs.promises.lstat(src);
        if (stat.isDirectory()) {
            await moverContenidoCarpeta(src, dest);
        } else {
            if (fs.existsSync(dest)) await fs.promises.unlink(dest);
            await fs.promises.rename(src, dest);
        }
    }));
    try { await fs.promises.rmdir(origen); } catch (e) { }
}

function extractZipAsync(zipPath, targetDir, timeoutMs = 15 * 60 * 1000) {
    return new Promise((resolve, reject) => {
        // Si por lo que sea el callback de AdmZip no llega nunca, se convierte en un error
        // visible en vez de dejar la UI colgada para siempre.
        const t = setTimeout(() => reject(new Error('La extracción tardó demasiado. Reintenta o usa "Reparar instancia".')), timeoutMs);
        const fin = (err) => { clearTimeout(t); if (err) reject(err); else resolve(); };
        try {
            const z = new AdmZip(zipPath);
            z.extractAllToAsync(targetDir, true, false, (err) => fin(err));
        } catch (e) { fin(e); }
    });
}

// =========================================================
// VAULT DE MODS (protección contra modificación manual)
// =========================================================
// Los .jar NO viven en texto plano en disco salvo el rato en que
// el juego está realmente corriendo. Se guardan cifrados (AES-256-GCM)
// en una carpeta oculta y se descifran a "mods/" justo antes de lanzar.
// Límite real: esto detiene la edición manual casual de mods entre
// partidas; no es DRM irrompible, ya que el binario corre en la
// máquina del usuario y Minecraft necesita el jar en claro para jugar.
const VAULT_SECRET = 'Migajas_ModVault_v1'; // cambia esto en tu propio fork

// v1 (instalaciones antiguas) mezclaba os.hostname() en la clave. El hostname NO es estable: en macOS
// cambia según la red a la que te conectes (DHCP) y en Windows al renombrar el equipo. Cuando cambiaba,
// ningún mod del vault se podía descifrar y el jugador quedaba bloqueado con "Mods alterados".
// v2 solo depende de la ruta de datos del launcher. Las entradas ya selladas siguen leyéndose con v1
// (marcadas sin "kv"); las nuevas se sellan con v2 (kv: 2).
const _clavesVault = {};
function getVaultKey(version = 2) {
    if (!_clavesVault[version]) {
        const tag = version === 1
            ? os.hostname() + '|' + app.getPath('userData')
            : 'v2|' + app.getPath('userData');
        _clavesVault[version] = crypto.scryptSync(VAULT_SECRET, tag, 32);
    }
    return _clavesVault[version];
}
function claveDeEntrada(entry) {
    return getVaultKey(entry && entry.kv === 2 ? 2 : 1);
}

function vaultDirPara(instancePath) {
    return path.join(GAME_ROOT, '.vault', path.basename(instancePath));
}

async function ocultarCarpeta(dir) {
    if (process.platform === 'win32') {
        try { await execFileAsync('attrib', ['+h', '+s', dir]); } catch (e) { }
    }
    // Antes aquí se hacía chmod 0o500 (sin escritura). En macOS/Linux eso impedía crear archivos nuevos
    // en el vault al resellar y borrar la instancia (EACCES). El vault ya va cifrado: no hace falta.
}

// Devuelve permisos de escritura al vault (por si quedó en 0500 de una versión anterior) y lo des-oculta.
async function liberarVault(dir) {
    if (!fs.existsSync(dir)) return;
    try { await fs.promises.chmod(dir, 0o700); } catch (e) { }
    await liberarCarpetaMods(dir);
}

// Endurece la carpeta mods/ EN CLARO mientras existe (solo dura lo que
// dura la partida). No es DRM irrompible -el binario corre en la máquina
// del jugador-, pero sí sube bastante el listón frente a "arrastrar y
// soltar" un jar o abrir la carpeta sin más:
//  - Windows: se oculta (+h +s, no sale en el explorador con vista normal)
//    y se le niega el permiso de escritura al propio usuario con icacls,
//    así ni el jugador ni un script casual pueden añadir/borrar/editar
// Oculta la carpeta mods/ EN CLARO mientras existe (solo dura lo que dura
// la partida: se reconstruye desde cero en cada lanzamiento y se borra al
// cerrar el juego). Es una capa de OSCURIDAD, no de bloqueo real: se
// probó negar el permiso de escritura (chmod/icacls), pero eso interfería
// con cómo Java/Forge/el antivirus tocan esos archivos y provocaba falsos
// positivos en la verificación de integridad (mods legítimos marcados
// como "modificados" sin haber sido tocados). La protección real contra
// manipulación no depende de permisos de archivo, sino de dos cosas que sí
// son fiables: (1) la carpeta se reconstruye 100% desde el vault cifrado
// en cada lanzamiento, así que cualquier cambio manual entre partidas se
// pierde solo; y (2) verificarIntegridadMods() compara cada archivo recién
// descifrado contra su hash original justo antes de lanzar.
async function ocultarCarpetaMods(dir) {
    if (process.platform === 'win32') {
        try { await execFileAsync('attrib', ['+h', '+s', dir]); } catch (e) { }
    }
    // (En macOS/Linux no hay un equivalente directo a "ocultar" una carpeta
    // sin cambiarle el nombre, y renombrarla rompería la ruta que usa
    // minecraft-launcher-core, así que ahí queda solo con el nombre normal.)
}

// Ya no hace falta revertir permisos porque ocultarCarpetaMods no los toca;
// se deja como no-op por compatibilidad con el resto del código.
async function liberarCarpetaMods(dir) {
    if (!fs.existsSync(dir)) return;
    if (process.platform === 'win32') {
        try { await execFileAsync('attrib', ['-h', '-s', dir]); } catch (e) { }
    }
}

async function cifrarArchivoAlVault(srcFile, vaultDir, key) {
    const data = await fs.promises.readFile(srcFile);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    const outName = crypto.createHash('sha1').update(path.basename(srcFile)).digest('hex') + '.enc';
    await fs.promises.writeFile(path.join(vaultDir, outName), enc);
    return { file: outName, iv: iv.toString('base64'), tag: tag.toString('base64'), hash, kv: 2 };
}

async function descifrarArchivoDelVault(entry, vaultDir, destFile, key) {
    const encData = await fs.promises.readFile(path.join(vaultDir, entry.file));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    const dec = Buffer.concat([decipher.update(encData), decipher.final()]);
    const hash = crypto.createHash('sha256').update(dec).digest('hex');
    if (hash !== entry.hash) throw new Error(`Integridad fallida en ${entry.name} (¿archivo del vault corrupto o manipulado?)`);
    await fs.promises.writeFile(destFile, dec);
}

// Cifra todo lo que haya en instancePath/mods y borra el original en claro
async function sellarModsInstancia(instancePath) {
    const modsDir = path.join(instancePath, 'mods');
    if (!fs.existsSync(modsDir)) return;

    const vaultDir = vaultDirPara(instancePath);
    await fs.promises.mkdir(vaultDir, { recursive: true });
    await liberarVault(vaultDir); // repara vaults que una versión anterior dejó en solo-lectura
    const key = getVaultKey(2);

    const manifestPath = path.join(vaultDir, 'manifest.json');
    let manifest = [];
    if (fs.existsSync(manifestPath)) {
        try { manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')); } catch (e) { manifest = []; }
    }

    const files = (await fs.promises.readdir(modsDir)).filter(f => f.endsWith('.jar'));
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (files.length > 20 && i % 20 === 0) log(`🔒 Cifrando mods (${i}/${files.length})...`);
        const entry = await cifrarArchivoAlVault(path.join(modsDir, f), vaultDir, key);
        const idx = manifest.findIndex(m => m.name === f);
        const record = { name: f, enabled: true, ...entry };
        if (idx !== -1) manifest[idx] = { ...manifest[idx], ...record, enabled: manifest[idx].enabled };
        else manifest.push(record);
    }

    await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await fs.promises.rm(modsDir, { recursive: true, force: true });
    await ocultarCarpeta(vaultDir);
    log(`🔒 ${files.length} mod(s) sellados en el vault cifrado.`);
}

// Descifra al vuelo los mods habilitados justo antes de lanzar el juego
async function desellarModsInstancia(instancePath) {
    const vaultDir = vaultDirPara(instancePath);
    const manifestPath = path.join(vaultDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return; // instancia sin vault (legado)

    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    const modsDir = path.join(instancePath, 'mods');
    // Si quedó una carpeta bloqueada de una sesión anterior (crash, corte
    // de luz), hay que devolverle permisos antes de poder borrarla.
    await liberarCarpetaMods(modsDir);
    await fs.promises.rm(modsDir, { recursive: true, force: true }).catch(() => { });
    await fs.promises.mkdir(modsDir, { recursive: true });

    for (const entry of manifest) {
        if (entry.enabled === false) continue;
        await descifrarArchivoDelVault(entry, vaultDir, path.join(modsDir, entry.name), claveDeEntrada(entry));
    }

    // Ya con los .jar en su sitio, se oculta y se bloquea la carpeta para
    // que el jugador no pueda entrar a tocar nada mientras juega.
    await ocultarCarpetaMods(modsDir);
}

// Comprueba, justo antes de lanzar, que lo que hay en mods/ (ya
// descifrado) coincide byte a byte con lo que dice el manifest cifrado.
// Si algo no cuadra -un jar reemplazado, borrado o editado a mano en la
// pequeña ventana entre el descifrado y el lanzamiento- se corta el
// lanzamiento en vez de dejar entrar al jugador con mods alterados.
//
// Se reintenta una vez tras una breve espera antes de dar un fallo por
// bueno: justo después de escribir un .jar en disco, un antivirus puede
// tenerlo bloqueado/a medio escanear una fracción de segundo, y eso podía
// leerse como "modificado" sin que nadie lo hubiera tocado.
async function hashDeArchivo(ruta) {
    const data = await fs.promises.readFile(ruta);
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function verificarIntegridadMods(instancePath) {
    const vaultDir = vaultDirPara(instancePath);
    const manifestPath = path.join(vaultDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return; // sin vault, no hay nada que verificar

    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    const modsDir = path.join(instancePath, 'mods');

    for (const entry of manifest) {
        if (entry.enabled === false) continue;
        const modFile = path.join(modsDir, entry.name);

        let intento = 0;
        let ultimoError = null;
        while (intento < 2) {
            try {
                if (!fs.existsSync(modFile)) throw new Error('missing');
                const hash = await hashDeArchivo(modFile);
                if (hash === entry.hash) { ultimoError = null; break; }
                ultimoError = new Error('mismatch');
            } catch (e) { ultimoError = e; }
            intento++;
            if (intento < 2) await new Promise(r => setTimeout(r, 400));
        }

        if (ultimoError) {
            const motivo = ultimoError.message === 'missing' ? 'falta en disco' : 'no coincide con el original';
            log(`⚠️ Verificación de mods: "${entry.name}" ${motivo}. Reintentando desde el vault antes de rendirse...`);
            // Último recurso antes de bloquear el lanzamiento: volver a
            // descifrar SOLO ese archivo directamente desde el vault
            // (fuente de verdad) y comprobarlo de nuevo.
            try {
                await descifrarArchivoDelVault(entry, vaultDir, modFile, claveDeEntrada(entry));
                const hash = await hashDeArchivo(modFile);
                if (hash === entry.hash) continue; // se recuperó solo, sigue con el siguiente mod
            } catch (e) { /* cae al error final de abajo */ }

            throw new Error(`El mod "${entry.name}" ${motivo} y no se pudo recuperar del vault. Puede que fue modificado a mano.`);
        }
    }
}

// Borra la carpeta mods en claro cuando el juego ya no la necesita
async function limpiarModsEnClaro(instancePath) {
    const vaultDir = vaultDirPara(instancePath);
    if (!fs.existsSync(path.join(vaultDir, 'manifest.json'))) return; // sin vault, no tocar nada
    const modsDir = path.join(instancePath, 'mods');
    await liberarCarpetaMods(modsDir); // primero se le devuelve permiso de escritura, si no el borrado falla
    try {
        // maxRetries/retryDelay: justo al cerrar el juego, Windows/el antivirus pueden
        // tardar un instante en soltar el handle de los .jar. Antes esto fallaba en
        // silencio y la carpeta se quedaba visible.
        await fs.promises.rm(modsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (e) {
        log(`⚠️ No se pudo limpiar mods/ en claro todavía (bloqueada): ${e.message}. Reintentando...`);
        setTimeout(() => {
            liberarCarpetaMods(modsDir).finally(() => {
                fs.promises.rm(modsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
                    .catch(() => log("⚠️ mods/ sigue bloqueada; se limpiará en el próximo lanzamiento."));
            });
        }, 3000);
    }
}

// Por si el proceso se cerró de golpe (crash, cierre forzado, corte de luz) y dejó
// carpetas mods/ en claro de una sesión anterior: se barren todas al iniciar la app.
async function limpiarModsHuerfanosAlIniciar() {
    const instancesDir = path.join(GAME_ROOT, "instances");
    if (!fs.existsSync(instancesDir)) return;
    try {
        const ids = await fs.promises.readdir(instancesDir);
        for (const id of ids) {
            const instancePath = path.join(instancesDir, id);
            if (await juegoActivoEn(instancePath)) continue; // hay un Minecraft vivo ahí: NO tocarle los mods
            const manifestPath = path.join(vaultDirPara(instancePath), 'manifest.json');
            if (fs.existsSync(manifestPath) && fs.existsSync(path.join(instancePath, 'mods'))) {
                await liberarCarpetaMods(path.join(instancePath, 'mods'));
                await fs.promises.rm(path.join(instancePath, 'mods'), { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => { });
            }
        }
    } catch (e) { }
}

// --- WINDOWS ---
function createWindow() {
    splash = new BrowserWindow({
        width: 300, height: 400, transparent: true,
        frame: false, alwaysOnTop: true, center: true,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    splash.loadFile('splash.html');

    win = new BrowserWindow({
        width: 1000, height: 650, title: "Migajas Launcher",
        frame: false, show: false, backgroundColor: '#0f0f0f',
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            // SEGURIDAD: antes esto era { nodeIntegration: true, contextIsolation: false },
            // lo que le daba a CUALQUIER script que corriera en index.html (incluido uno
            // inyectado por un XSS o por contenido remoto cargado sin querer) acceso directo
            // a Node.js: fs, child_process, require('electron'), etc. Es decir: en la
            // práctica, cualquier fallo de sanitización en el HTML/JS del renderer se
            // traducía directamente en ejecución de código arbitrario en el sistema del
            // jugador. Ahora el renderer NO tiene Node, está aislado (sandbox) y solo puede
            // hablar con el proceso principal a través de las funciones puntuales que
            // preload.js expone explícitamente vía contextBridge.
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            spellcheck: false
        }
    });
    win.loadFile('index.html');
    win.once('ready-to-show', () => {
        setTimeout(() => {
            if (splash && !splash.isDestroyed()) splash.close();
            if (win && !win.isDestroyed()) { win.show(); win.focus(); }
        }, 2500);
    });

    // Registra en la terminal cualquier fallo de carga de la página o del
    // preload script, que de otro modo solo se ven (si acaso) dentro de DevTools.
    win.webContents.on('did-fail-load', (e, errorCode, errorDescription, validatedURL) => {
        console.error(`[FALLO DE CARGA] ${validatedURL} -> (${errorCode}) ${errorDescription}`);
    });
    win.webContents.on('preload-error', (e, preloadPath, error) => {
        console.error(`[FALLO DE PRELOAD] ${preloadPath}:`, error);
    });
    win.webContents.on('console-message', (event) => {
        // Electron >= 34 manda un único objeto Event con { level, message, lineNumber,
        // sourceId }, donde level es un string ('error'/'warning'/'info'/'debug').
        // (Firma antigua con 5 argumentos posicionales -> deprecada, ya no se usa.)
        const { level, message, lineNumber, sourceId } = event;
        if (level === 'error') console.log(`[RENDERER] ${sourceId}:${lineNumber} -> ${message}`);
    });

    // Cualquier intento de abrir una ventana nueva (target="_blank", window.open,
    // un <a> con target, etc.) se manda al navegador del sistema con
    // shell.openExternal en vez de crear una BrowserWindow de Electron. Así, un
    // enlace malicioso (o un XSS) no puede abrir una segunda ventana dentro del
    // propio launcher con las mismas capacidades que la ventana principal.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
        return { action: 'deny' };
    });

    // Bloquea que la ventana principal navegue a cualquier URL que no sea su
    // propio index.html local. Sin esto, cualquier vector que lograra ejecutar
    // "window.location = ..." (XSS, contenido de un mod, etc.) podría redirigir
    // toda la ventana a una página de phishing indistinguible del launcher real.
    win.webContents.on('will-navigate', (e, url) => {
        const destino = path.join(__dirname, 'index.html');
        if (!(url.startsWith('file://') && url.includes(path.basename(destino)))) {
            e.preventDefault();
        }
    });

    // Si el usuario intenta cerrar la ventana (X, Alt+F4, etc.) mientras
    // Minecraft está abierto, no se destruye: solo se oculta. Así el
    // launcher sigue vivo en segundo plano controlando el proceso del
    // juego y no se corta nada a mitad de partida.
    win.on('close', (e) => {
        if (jugando) {
            e.preventDefault();
            win.hide();
        }
    });
}

app.whenReady().then(() => {
    if (!instanciaUnica) return; // era un segundo launcher: no inicializar nada
    // --- OPTIMIZACIONES DE RENDIMIENTO ---
    // SEGURIDAD: se quitaron 'disable-site-isolation-trials' y
    // 'disable-features=OutOfBlinkCors'. Ambos flags existían "para rendimiento"
    // pero lo que hacen en realidad es debilitar el aislamiento de procesos por
    // sitio y la aplicación de CORS de Chromium: exactamente las dos barreras que
    // frenan a un proceso renderer comprometido de leer memoria o hacer peticiones
    // fuera de su origen. Con contextIsolation+sandbox activados (ver createWindow)
    // no hace falta tocar esto, así que se dejan en su valor por defecto (seguro).
    // Se quitó 'ignore-gpu-blocklist': forzaba aceleración GPU en tarjetas/drivers que Chromium marca
    // como problemáticos, para dibujar una UI que no la necesita, y compite por la GPU con el juego
    // (en portátiles con gráfica integrada puede acabar en cuelgues del driver durante la partida).

    // NOTA DE SEGURIDAD: la CSP se define como <meta> dentro de index.html en vez
    // de aquí. Se probó primero inyectándola como cabecera HTTP vía
    // session.defaultSession.webRequest.onHeadersReceived, pero eso resultó poco
    // fiable con páginas cargadas por file:// (el origen 'self' no se resuelve
    // igual que en http/https, y en la práctica llegó a impedir que index.html
    // cargara). La etiqueta <meta http-equiv="Content-Security-Policy"> en el
    // <head> del propio HTML es el mecanismo estándar y fiable para esto en apps
    // Electron que cargan archivos locales.
    initRoots();
    createWindow();
    limpiarModsHuerfanosAlIniciar();
    iniciarVigilanteModpacks();
    if (tieneDiscord) {
        try {
            rpcClient = new DiscordRPC.Client({ transport: 'ipc' });
            rpcClient.login({ clientId }).catch(() => { });
        } catch (e) { }
    }

    // --- AUTO UPDATER --- (ver sección "ACTUALIZACIÓN DEL LAUNCHER")
    iniciarActualizadorLauncher();
});

// =========================================================
// ACTUALIZACIÓN DEL LAUNCHER (electron-updater + GitHub Releases)
// =========================================================
// Flujo: al abrir el launcher (y cada 30 min) se consulta la última release publicada en GitHub.
// Si hay una versión más nueva se muestra un popup: "Actualizar ahora" / "Más tarde".
// Al aceptar se descarga con barra de progreso y luego "Reiniciar e instalar" (o se instala sola
// al cerrar el launcher). El popup es una ventana propia creada desde aquí, así que NO depende de
// lo que tengan index.html ni preload.js. Si prefieres dibujar tú el aviso en la UI, pon
// ACTUALIZADOR.popup = false y escucha el evento 'updater-event' (sigue emitiéndose igual).
const ACTUALIZADOR = {
    owner: 'Dexi-lov',
    repo: 'migajas-launcher',
    popup: true,
    // macOS: electron-updater solo instala si la app está firmada con certificado de Apple. Sin firma,
    // el botón abre la página de descargas en vez de intentar una instalación que fallaría.
    macManual: true,
    primeraRevisionMs: 6000,
    revisarCadaMs: 30 * 60 * 1000
};

let autoUpdaterRef = null;
let updInfo = null;            // { version, notas } de la versión nueva encontrada
let updEstado = 'idle';        // idle | disponible | descargando | descargada | error
let updDescartada = '';        // versión pospuesta con "Más tarde": no se vuelve a ofrecer en esta sesión
let updMensaje = '';
let updProgreso = { percent: 0, velocidad: '' };
let popupUpd = null;
let popupUpdListo = false;

// Las notas de la release llegan como HTML (o array de {version, note}). Se pasan a texto plano.
function notasLimpias(raw) {
    let t = Array.isArray(raw) ? raw.map(r => (r && r.note) || '').join('\n') : String(raw || '');
    t = t.replace(/<\s*br\s*\/?>|<\/(p|div|h[1-6]|ul|ol|li)>/gi, '\n').replace(/<\s*li[^>]*>/gi, '• ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
        .replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    return t.length > 900 ? t.slice(0, 900).trimEnd() + '…' : t;
}

function estadoUpd() {
    return {
        estado: updEstado,
        actual: app.getVersion(),
        nueva: updInfo ? updInfo.version : '',
        notas: updInfo ? updInfo.notas : '',
        percent: updProgreso.percent,
        velocidad: updProgreso.velocidad,
        mensaje: updMensaje,
        manual: ACTUALIZADOR.macManual && process.platform === 'darwin'
    };
}

// Avisa a la UI propia (si la hay) con los mismos tipos de evento que ya existían.
function avisarRendererUpd(tipo, extra = {}) {
    if (win && !win.isDestroyed()) win.webContents.send('updater-event', { type: tipo, ...extra });
}

// El banner de index.html es el recordatorio permanente dentro de la app. Se sincroniza cuando el popup
// no está abierto (si lo está, el popup ya informa de todo y el banner no duplica el aviso).
function sincronizarBanner() {
    if (!updInfo || updEstado === 'idle') return;
    if (popupUpd && !popupUpd.isDestroyed()) return;
    avisarRendererUpd('available', { info: { version: updInfo.version, releaseNotes: updInfo.notas } });
    if (updEstado === 'descargando') avisarRendererUpd('progress', { progress: updProgreso.percent });
    if (updEstado === 'descargada') avisarRendererUpd('downloaded');
    if (updEstado === 'error') avisarRendererUpd('error', { message: updMensaje });
}

function renderPopupUpd() {
    if (!popupUpd || popupUpd.isDestroyed() || !popupUpdListo) return;
    popupUpd.webContents.executeJavaScript('render(' + JSON.stringify(estadoUpd()) + ')').catch(() => { });
}

function cerrarPopupUpd() {
    if (popupUpd && !popupUpd.isDestroyed()) popupUpd.destroy();
    popupUpd = null; popupUpdListo = false;
}

function crearPopupUpd() {
    popupUpdListo = false;
    popupUpd = new BrowserWindow({
        width: 460, height: 400,
        parent: (win && !win.isDestroyed() && win.isVisible()) ? win : undefined,
        frame: false, show: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
        backgroundColor: '#15151b', title: 'Actualización',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false }
    });
    popupUpd.setMenu(null);
    const wc = popupUpd.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Los botones son enlaces migajas-update://<accion>; se interceptan aquí (sin preload ni IPC).
    wc.on('will-navigate', (e, url) => {
        e.preventDefault();
        const m = /^migajas-update:\/\/([a-z]+)/.exec(url);
        if (m) accionPopupUpd(m[1]);
    });
    wc.once('did-finish-load', () => {
        popupUpdListo = true;
        renderPopupUpd();
        if (popupUpd && !popupUpd.isDestroyed()) { popupUpd.show(); popupUpd.focus(); }
    });
    popupUpd.on('closed', () => { popupUpd = null; popupUpdListo = false; sincronizarBanner(); });
    popupUpd.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML_POPUP_ACTUALIZACION)).catch(() => { });
}

// Muestra (o actualiza) el popup. No molesta mientras se juega o se prepara una partida:
// se reintenta solo al cerrar Minecraft y en cada revisión periódica.
function ofrecerActualizacion() {
    if (!ACTUALIZADOR.popup || !updInfo || updEstado === 'idle') return;
    if (jugando || lanzando) return;
    if (updEstado === 'disponible' && updDescartada === updInfo.version) return;
    if (popupUpd && !popupUpd.isDestroyed()) { renderPopupUpd(); popupUpd.show(); popupUpd.focus(); return; }
    crearPopupUpd();
}

async function descargarActualizacion() {
    if (!autoUpdaterRef) return;
    updEstado = 'descargando'; updMensaje = ''; updProgreso = { percent: 0, velocidad: '' };
    renderPopupUpd();
    try { await autoUpdaterRef.downloadUpdate(); }
    catch (e) { errorActualizacion(e); }
}

function errorActualizacion(err) {
    const msg = (err && err.message) ? String(err.message).split('\n')[0].slice(0, 200) : String(err);
    escribirLog('[updater] error: ' + msg);
    if (updEstado === 'descargando') {   // los fallos de las revisiones en segundo plano no molestan al jugador
        updEstado = 'error'; updMensaje = msg;
        avisarRendererUpd('error', { message: msg });
        if (win && !win.isDestroyed()) win.setProgressBar(-1);
        ofrecerActualizacion();
    }
}

function instalarActualizacion() {
    if (!autoUpdaterRef || updEstado !== 'descargada') return;
    if (jugando || lanzando) { updMensaje = 'Cierra Minecraft antes de reiniciar el launcher.'; renderPopupUpd(); return; }
    // El instalador abre la versión nueva mientras este proceso termina: hay que soltar el bloqueo de
    // instancia única o la versión nueva se cerraría sola al arrancar.
    try { app.releaseSingleInstanceLock(); } catch (e) { }
    cerrarPopupUpd();
    setImmediate(() => autoUpdaterRef.quitAndInstall(true, true)); // silencioso y se reabre solo
}

function accionPopupUpd(accion) {
    switch (accion) {
        case 'actualizar': case 'reintentar':
            if (ACTUALIZADOR.macManual && process.platform === 'darwin') {
                shell.openExternal(`https://github.com/${ACTUALIZADOR.owner}/${ACTUALIZADOR.repo}/releases/latest`);
                if (updInfo) updDescartada = updInfo.version;
                cerrarPopupUpd();
            } else descargarActualizacion();
            break;
        case 'instalar': instalarActualizacion(); break;
        case 'despues': if (updInfo) updDescartada = updInfo.version; cerrarPopupUpd(); break;
        case 'alcerrar': if (updInfo) updDescartada = updInfo.version; cerrarPopupUpd(); break; // autoInstallOnAppQuit la instala
        case 'cerrar': cerrarPopupUpd(); break;
    }
}

async function revisarActualizacionLauncher() {
    if (!autoUpdaterRef) return null;
    if (updEstado === 'descargando') return null;
    if (updEstado === 'descargada') { ofrecerActualizacion(); return null; }
    try { return await autoUpdaterRef.checkForUpdates(); }
    catch (e) { escribirLog('[updater] no se pudo comprobar: ' + ((e && e.message) || e)); return null; }
}

function iniciarActualizadorLauncher() {
    let autoUpdater;
    try { ({ autoUpdater } = require('electron-updater')); }
    catch (e) {
        // Causa típica de "el updater no hace nada": electron-updater está en devDependencies y no se empaqueta.
        escribirLog('[updater] electron-updater no está disponible (debe estar en "dependencies", no en "devDependencies"): ' + e.message);
        return;
    }
    autoUpdaterRef = autoUpdater;
    autoUpdater.logger = {
        info: (m) => escribirLog('[updater] ' + m), warn: (m) => escribirLog('[updater] WARN ' + m),
        error: (m) => escribirLog('[updater] ERROR ' + m), debug: () => { }
    };
    autoUpdater.setFeedURL({ provider: 'github', owner: ACTUALIZADOR.owner, repo: ACTUALIZADOR.repo });
    autoUpdater.autoDownload = false;          // primero se pregunta
    autoUpdater.autoInstallOnAppQuit = true;   // "Al cerrar" / ignorar el aviso: se instala al salir
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    if (process.env.MIGAJAS_UPDATER_DEV === '1') autoUpdater.forceDevUpdateConfig = true; // pruebas con dev-app-update.yml

    autoUpdater.on('update-available', (info) => {
        updInfo = { version: String(info.version), notas: notasLimpias(info.releaseNotes) };
        if (updEstado === 'idle' || updEstado === 'disponible') updEstado = 'disponible';
        escribirLog(`[updater] versión nueva disponible: ${updInfo.version} (actual ${app.getVersion()})`);
        ofrecerActualizacion();
        sincronizarBanner(); // si el popup no se abrió (se está jugando, o ya se pospuso), queda el banner
    });
    autoUpdater.on('update-not-available', () => { if (updEstado === 'disponible') updEstado = 'idle'; });
    autoUpdater.on('download-progress', (p) => {
        updProgreso = { percent: Math.max(0, Math.min(100, p.percent || 0)), velocidad: p.bytesPerSecond ? (p.bytesPerSecond / 1048576).toFixed(1) : '' };
        if (win && !win.isDestroyed()) win.setProgressBar(updProgreso.percent / 100);
        avisarRendererUpd('progress', { progress: updProgreso.percent });
        renderPopupUpd();
    });
    autoUpdater.on('update-downloaded', () => {
        updEstado = 'descargada'; updMensaje = '';
        if (win && !win.isDestroyed()) win.setProgressBar(-1);
        ofrecerActualizacion();
        sincronizarBanner();
    });
    autoUpdater.on('error', (err) => errorActualizacion(err));

    // Compatibilidad con la UI anterior ('updater-action' desde index.html/preload)
    ipcMain.on('updater-action', (e, action) => {
        if (action === 'download') accionPopupUpd('actualizar');
        if (action === 'install') accionPopupUpd('instalar');
    });
    // Para un botón "Buscar actualizaciones" en la UI (opcional)
    ipcMain.handle('launcher-update-check', async () => {
        updDescartada = '';
        await revisarActualizacionLauncher();
        return { actual: app.getVersion(), estado: updEstado, version: updInfo ? updInfo.version : null };
    });

    setTimeout(revisarActualizacionLauncher, ACTUALIZADOR.primeraRevisionMs);
    setInterval(() => { revisarActualizacionLauncher(); ofrecerActualizacion(); }, ACTUALIZADOR.revisarCadaMs).unref();
}

const HTML_POPUP_ACTUALIZACION = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root{--bg:#15151b;--card:#1d1d26;--line:#2b2b38;--text:#f2f2f7;--muted:#9a9ab0;--a1:#8b5cf6;--a2:#6d3df0;--err:#f87171}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font:14px/1.45 "Segoe UI",system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;border:1px solid var(--line);user-select:none;-webkit-app-region:drag;overflow:hidden}
.head{padding:22px 24px 6px;display:flex;gap:14px;align-items:center}
.ico{width:46px;height:46px;border-radius:13px;background:linear-gradient(135deg,var(--a1),var(--a2));display:grid;place-items:center;font-size:22px;flex:none}
h1{font-size:17px;font-weight:700}
.ver{color:var(--muted);font-size:13px;margin-top:2px}
.body{padding:10px 24px 0;flex:1;display:flex;flex-direction:column;gap:12px;min-height:0}
.sub{color:var(--muted)}
.notas{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;white-space:pre-wrap;overflow:auto;flex:1;min-height:60px;font-size:13px;user-select:text;-webkit-app-region:no-drag}
.bar{height:10px;background:var(--card);border-radius:99px;overflow:hidden}
.fill{height:100%;width:0;background:linear-gradient(90deg,var(--a1),var(--a2));transition:width .2s}
.pct{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:6px}
.msg{color:var(--err);font-size:13px}
.btns{padding:14px 24px 22px;display:flex;gap:10px;justify-content:flex-end;-webkit-app-region:no-drag;min-height:68px}
a.btn{text-decoration:none;color:var(--text);background:var(--card);padding:10px 18px;border-radius:10px;font-weight:600;cursor:pointer;border:1px solid var(--line)}
a.btn:hover{background:#262633}
a.btn.p{background:linear-gradient(135deg,var(--a1),var(--a2));border-color:transparent}
a.btn.p:hover{filter:brightness(1.12)}
.hide{display:none!important}
</style></head><body>
<div class="head"><div class="ico">⬆</div><div><h1 id="t">Actualización</h1><div class="ver" id="ver"></div></div></div>
<div class="body">
  <div class="sub" id="sub"></div>
  <div class="notas hide" id="notas"></div>
  <div class="hide" id="prog"><div class="bar"><div class="fill" id="fill"></div></div><div class="pct"><span id="pct">0%</span><span id="vel"></span></div></div>
  <div class="msg" id="msg"></div>
</div>
<div class="btns" id="btns"></div>
<script>
const $=id=>document.getElementById(id);
function btn(label,accion,primario){const a=document.createElement('a');a.className='btn'+(primario?' p':'');a.textContent=label;a.href='migajas-update://'+accion;return a;}
function render(s){
  $('ver').textContent='v'+s.actual+'  →  v'+s.nueva;
  $('msg').textContent=s.mensaje||'';
  const b=$('btns'); b.textContent='';
  const conNotas=!!s.notas&&(s.estado==='disponible'||s.estado==='descargada');
  $('notas').classList.toggle('hide',!conNotas); $('notas').textContent=s.notas||'';
  $('prog').classList.toggle('hide',s.estado!=='descargando');
  if(s.estado==='disponible'){
    $('t').textContent='Nueva versión disponible';
    $('sub').textContent=s.manual?'Descarga el instalador nuevo desde GitHub y ábrelo para actualizar.':'Actualiza ahora para tener las últimas mejoras y correcciones.';
    b.append(btn('Más tarde','despues'),btn(s.manual?'Descargar desde GitHub':'Actualizar ahora','actualizar',true));
  }else if(s.estado==='descargando'){
    $('t').textContent='Descargando actualización…';
    $('sub').textContent='No cierres el launcher. Esto tardará solo un momento.';
    const p=Math.round(s.percent||0); $('fill').style.width=p+'%'; $('pct').textContent=p+'%'; $('vel').textContent=s.velocidad?s.velocidad+' MB/s':'';
  }else if(s.estado==='descargada'){
    $('t').textContent='Actualización lista';
    $('sub').textContent='El launcher se reiniciará solo para terminar de instalarla.';
    b.append(btn('Al cerrar','alcerrar'),btn('Reiniciar e instalar','instalar',true));
  }else if(s.estado==='error'){
    $('t').textContent='No se pudo actualizar';
    $('sub').textContent='Puedes reintentarlo o seguir usando esta versión.';
    b.append(btn('Cerrar','cerrar'),btn('Reintentar','reintentar',true));
  }
}
</script></body></html>`;

app.on('window-all-closed', () => {
    if (jugando) return; // No cerrar el launcher mientras Minecraft sigue abierto
    if (process.platform !== 'darwin') app.quit();
});

// =========================================================
// API IPC
// =========================================================

// =========================================================
// SESIÓN DE MICROSOFT: guardado y restauración segura
// =========================================================
// Antes: login-microsoft nunca guardaba nada. Cada vez que se cerraba y
// volvía a abrir el launcher no había ningún rastro de la sesión anterior,
// así que la UI no tenía más remedio que asumir "offline" hasta que el
// jugador volviera a pulsar "Iniciar sesión" y pasara otra vez por la
// ventana emergente de Microsoft. Ahora:
//  1) Tras un login correcto se guarda el token "refrescable" (mclc(true))
//     cifrado en disco con safeStorage (usa Credential Manager en Windows,
//     Keychain en macOS y el keyring del sistema en Linux: la clave de
//     cifrado nunca la maneja el propio launcher ni queda en texto plano).
//  2) Al arrancar, el renderer puede llamar a 'login-microsoft-silent' para
//     intentar recuperar esa sesión y refrescar el token sin abrir ninguna
//     ventana emergente. Si el refresh token todavía es válido (dura varios
//     meses mientras se use), el jugador queda logueado sin tocar nada.
//  3) Si el refresh falla (token revocado, expirado, sesión corrupta) se
//     borra lo guardado y se cae a login manual, en vez de dejar al
//     launcher en un estado a medias.
function guardarSesion(tokenObj) {
    try {
        const json = JSON.stringify(tokenObj);
        if (!safeStorage.isEncryptionAvailable()) {
            // No hay backend de cifrado del SO disponible (poco común; p.ej. algunas
            // instalaciones de Linux sin keyring configurado). Se prefiere no
            // persistir sesión antes que guardarla sin cifrar en disco.
            log("⚠️ Cifrado de sesión no disponible en este sistema; no se recordará el login.");
            return;
        }
        const cifrado = safeStorage.encryptString(json);
        fs.writeFileSync(AUTH_FILE, cifrado);
    } catch (e) { log("⚠️ No se pudo guardar la sesión: " + e.message); }
}

function cargarSesionGuardada() {
    try {
        if (!fs.existsSync(AUTH_FILE) || !safeStorage.isEncryptionAvailable()) return null;
        const cifrado = fs.readFileSync(AUTH_FILE);
        return JSON.parse(safeStorage.decryptString(cifrado));
    } catch (e) { return null; }
}

function borrarSesionGuardada() {
    try { if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE); } catch (e) { }
}

// ─── Autenticación ───
ipcMain.handle('login-microsoft', async () => {
    try {
        const authManager = new Auth("select_account");
        const xboxManager = await authManager.launch("electron");
        const token = await xboxManager.getMinecraft();
        guardarSesion(token.mclc(true)); // guarda para poder restaurar la sesión la próxima vez
        return { success: true, profile: token.mclc() };
    } catch (e) { return { success: false, error: e.message }; }
});

// Intenta restaurar la sesión guardada SIN abrir la ventana de login de
// Microsoft. Pensado para llamarse una vez al arrancar la app, antes de
// decidir si se muestra la pantalla de login o se entra directo.
ipcMain.handle('login-microsoft-silent', async () => {
    const guardado = cargarSesionGuardada();
    if (!guardado) return { success: false, error: 'No hay sesión guardada' };
    try {
        const authManager = new Auth("select_account");
        let mc = tokenUtils.fromMclcToken(authManager, guardado);
        mc = await mc.refresh(false); // solo refresca si el token ya venció, no fuerza
        guardarSesion(mc.mclc(true)); // el refresh token puede rotar; se guarda la versión vigente
        return { success: true, profile: mc.mclc() };
    } catch (e) {
        // Token revocado/expirado (o sesión corrupta): no dejar basura a medias.
        borrarSesionGuardada();
        return { success: false, error: e.message };
    }
});

ipcMain.handle('logout-microsoft', () => {
    borrarSesionGuardada();
    return { success: true };
});

// Genera la MISMA UUID que calcula un servidor Vanilla/Spigot/Paper cuando
// está en online-mode=false: UUID v3 a partir del hash MD5 de
// "OfflinePlayer:<nick>" (así es como lo hace el propio Minecraft, vía
// java.util.UUID.nameUUIDFromBytes). Antes se usaba crypto.randomUUID(),
// que genera una UUID distinta en cada login: el servidor no reconocía al
// jugador como "el mismo" entre sesiones (perdía inventario/rango/permisos
// guardados por UUID) y algunos plugins de whitelist/anti-bot rechazaban la
// conexión al no coincidir con la UUID que ellos mismos esperaban.
function uuidOfflineDesdeNick(nick) {
    const hash = crypto.createHash('md5').update(`OfflinePlayer:${nick}`, 'utf8').digest();
    hash[6] = (hash[6] & 0x0f) | 0x30; // versión 3
    hash[8] = (hash[8] & 0x3f) | 0x80; // variante RFC 4122
    const hex = hash.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 4 + 8)}-${hex.slice(12, 4 + 12)}-${hex.slice(16, 4 + 16)}-${hex.slice(20)}`;
}

ipcMain.handle('login-offline', (e, nick) => {
    return {
        access_token: "null", client_token: "null",
        uuid: uuidOfflineDesdeNick(nick), name: nick,
        user_properties: {}, meta: { type: "mojang", demo: false }
    };
});

// ─── Registro interno de playtime ───
// NOTA: se quitó la gestión de "instancias personalizadas" (el usuario ya
// no puede crear/editar instancias propias desde la UI). INSTANCES_FILE
// ahora se usa solo internamente para guardar el tiempo jugado por cada
// modpack oficial del estudio (ver el evento 'close' del launcher, más abajo).
// Se deja este handler de solo-lectura por si la UI quiere mostrar el
// tiempo jugado de cada modpack, pero ya no permite escribir instancias.
ipcMain.handle('get-instances', async () => {
    try {
        if (!fs.existsSync(INSTANCES_FILE)) return [];
        const data = await fs.promises.readFile(INSTANCES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) { return []; }
});

// ─── Check / Borrar Instancias ───
ipcMain.handle('check-instancia', async (e, id) => {
    const p = rutaInstanciaSegura(id);
    if (!p) return false;
    try {
        if (!fs.existsSync(p)) return false;
        const files = await fs.promises.readdir(p);
        return files.length > 0;
    } catch (e) { return false; }
});

ipcMain.handle('borrar-instancia', async (e, id) => {
    // Sin validar "id" aquí, un renderer comprometido podía mandar algo como
    // "../../../.." y esto haría un rm recursivo fuera de la carpeta del
    // launcher. Se rechaza cualquier id que no pase idSeguro/rutaInstanciaSegura.
    const seguro = idSeguro(id);
    const p = rutaInstanciaSegura(id);
    if (!seguro || !p) return { success: false, error: 'ID de instancia inválido' };
    if (jugando || lanzando) return { success: false, error: 'No se puede borrar mientras se juega o se prepara una partida.' };
    try {
        if (fs.existsSync(p)) await fs.promises.rm(p, { recursive: true, force: true });
        const vaultDir = rutaDentroDe(path.join(GAME_ROOT, '.vault'), seguro);
        if (vaultDir && fs.existsSync(vaultDir)) {
            await liberarVault(vaultDir); // si no, en macOS/Linux el rm falla con EACCES (vault en 0500)
            await fs.promises.rm(vaultDir, { recursive: true, force: true });
        }
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});

// Muestra launcher.log en el explorador, para que el jugador pueda enviarlo a soporte.
ipcMain.on('abrir-log', () => { if (LOG_FILE && fs.existsSync(LOG_FILE)) shell.showItemInFolder(LOG_FILE); });

ipcMain.on('abrir-carpeta', async (e, id) => {
    const p = rutaInstanciaSegura(id);
    if (!p) return;
    try { if (!fs.existsSync(p)) await fs.promises.mkdir(p, { recursive: true }); } catch (err) { }
    shell.openPath(p);
});

// ─── Skins ───
ipcMain.handle('cambiar-skin', async (e, { token, imageBuffer, modelo }) => {
    try {
        const img = Buffer.from(imageBuffer.split(',')[1], 'base64');
        const d = new FormData();
        d.append("variant", modelo);
        d.append("file", img, { filename: 'skin.png' });
        await axios.post("https://api.minecraftservices.com/minecraft/profile/skins", d, {
            headers: { "Authorization": `Bearer ${token}`, ...d.getHeaders() }
        });
        return { success: true };
    } catch (err) { return { success: false, error: err.message }; }
});

// ─── Info del Sistema (RAM real) ───
ipcMain.handle('get-system-info', () => {
    const totalRam = Math.floor(os.totalmem() / 1024 / 1024 / 1024);
    return { totalRam };
});

// ─── Ping al Servidor Minecraft ───
ipcMain.handle('ping-servidor', async (e, serverIp) => {
    if (!serverIp) return { online: false };
    try {
        const res = await axios.get(`https://api.mcsrvstat.us/2/${serverIp}`, { timeout: 6000 });
        const d = res.data;
        return {
            online: d.online || false,
            players: d.players ? { online: d.players.online, max: d.players.max } : { online: 0, max: 0 },
            motd: d.motd ? (d.motd.clean?.[0] || '') : '',
            version: d.version || ''
        };
    } catch (e) { return { online: false }; }
});

// ─── Versión real del Loader de Fabric ───
ipcMain.handle('get-fabric-version', async (e, mcVersion) => {
    try {
        const res = await axios.get(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`, { timeout: 5000 });
        if (res.data && res.data.length > 0) {
            return { version: `fabric-loader-${res.data[0].loader.version}-${mcVersion}` };
        }
        return { version: null };
    } catch (e) { return { version: null }; }
});

ipcMain.handle('get-version', () => app.getVersion());
ipcMain.on('cerrar-app', () => {
    if (jugando) { if (win) win.hide(); return; } // Evita cerrar el launcher a mitad de partida
    app.quit();
});
ipcMain.on('minimizar-app', () => { if (win) win.minimize(); });

// ─── GESTOR DE MODS (DESHABILITADO A PROPÓSITO) ───
// Los mods son parte cerrada del modpack del estudio: el usuario no debe
// poder verlos ni activarlos/desactivarlos desde la UI. Los handlers se
// dejan como "stubs" que responden vacío/denegado en vez de eliminarlos
// del todo, para que la UI no rompa si todavía llama a estos canales.
ipcMain.handle('get-mods', async () => {
    // Nunca se expone el listado real de mods del vault.
    return [];
});

ipcMain.handle('toggle-mod', async () => {
    // Activar/desactivar mods manualmente ya no está permitido.
    return { success: false, error: 'La gestión de mods no está disponible: forman parte del modpack oficial.' };
});

// ─── REPARAR INSTANCIA ───
ipcMain.handle('repair-instance', async (e, id) => {
    const instP = rutaInstanciaSegura(id);
    if (!instP) return { success: false, error: 'ID de instancia inválido' };
    if (jugando || lanzando) return { success: false, error: 'No se puede reparar mientras se juega o se prepara una partida.' };
    try {
        // MCLC usa root = carpeta de la instancia, así que "versions" (jar + json de la versión y del
        // loader) y "natives" viven DENTRO de la instancia. Antes se borraba GAME_ROOT/versions, que no
        // existe, y la reparación no tocaba justo lo que suele estar corrupto.
        const paths = [
            path.join(GAME_ROOT, "libraries"),
            path.join(GAME_ROOT, "assets"),
            path.join(GAME_ROOT, "versions"),
            path.join(instP, "versions"),
            path.join(instP, "natives"),
            path.join(instP, "pack_info.json")
        ];
        for (const p of paths) {
            if (fs.existsSync(p)) await fs.promises.rm(p, { recursive: true, force: true });
        }
        // Instaladores del loader y descargas a medias: se vuelven a bajar limpios en el próximo lanzamiento.
        for (const f of await fs.promises.readdir(instP).catch(() => [])) {
            if (/^(?:neo)?forge-installer.*\.jar$/.test(f) || f.endsWith('.part')) {
                await fs.promises.unlink(path.join(instP, f)).catch(() => { });
            }
        }
        return { success: true };
    } catch (err) { return { success: false, error: err.message }; }
});

// ─── EXPORTAR / IMPORTAR ───
ipcMain.handle('export-instance', async (e, id) => {
    try {
        const instPath = rutaInstanciaSegura(id);
        if (!instPath || !fs.existsSync(instPath)) throw new Error("Instancia no encontrada");

        const savePath = dialog.showSaveDialogSync(win, {
            title: 'Exportar Instancia',
            defaultPath: `${id}.zip`,
            filters: [{ name: 'Zip Files', extensions: ['zip'] }]
        });

        if (savePath) {
            const zip = new AdmZip();
            // Solo exportar lo vital para no pesar gigas.
            // IMPORTANTE: 'mods' se excluye a propósito. Los mods del modpack
            // son propiedad del estudio y no deben poder extraerse ni verse
            // por esta vía; solo se descifran en caliente para jugar.
            const foldersToZip = ['config', 'resourcepacks', 'saves', 'options.txt'];
            for (const f of foldersToZip) {
                const fullP = path.join(instPath, f);
                if (fs.existsSync(fullP)) {
                    const stats = await fs.promises.lstat(fullP);
                    if (stats.isDirectory()) zip.addLocalFolder(fullP, f);
                    else zip.addLocalFile(fullP);
                }
            }
            await zip.writeZipPromise(savePath);
            return { success: true, path: savePath };
        }
        return { success: false, canceled: true };
    } catch (err) { return { success: false, error: err.message }; }
});

// NOTA: se eliminó 'import-instance'. Ya no se permite importar zips
// arbitrarios como instancias nuevas: solo existen los modpacks oficiales
// del estudio, así que no tiene sentido dejar esa puerta abierta.

// =========================================================
// ACTUALIZACIÓN AUTOMÁTICA DEL MODPACK (vía GitHub Gist)
// =========================================================
// El gist es la "fuente de la verdad": contiene la lista de modpacks con su
// version_pack. El launcher lo consulta al arrancar y cada cierto tiempo; si un
// modpack YA INSTALADO tiene una versión remota mayor que la local
// (pack_info.json), avisa a la UI con el evento 'modpack-update-disponible' y
// la UI puede pedir la actualización con el canal 'actualizar-modpack'.
// Además, 'lanzar-juego' sigue actualizando solo si detecta el pack desfasado,
// usando el mismo instalador (instalarModpack).
//
// IMPORTANTE (seguridad): quien pueda editar este gist puede hacer que los
// jugadores descarguen y ejecuten código arbitrario (los mods son .jar). Usa una
// cuenta propia con 2FA y, idealmente, rellena "sha256" en el gist para que el
// zip se verifique antes de instalarlo.
//
// Usa la URL "raw" SIN el hash de revisión, así siempre apunta a la última:
//   https://gist.githubusercontent.com/<usuario>/<id>/raw/<archivo>.json
const MODPACKS_GIST_URL = 'https://gist.githubusercontent.com/Dexi-lov/8f8babdea6a5bccfe2c2d8a4fe4d8849/raw/evento_migajas.json';
const INTERVALO_REVISION_MS = 10 * 60 * 1000; // cada 10 min
const packsActualizando = new Set();
let revisandoPacks = false;
let ultimaFirmaAvisada = '';

async function obtenerConfigsRemotas() {
    // El parámetro "t" evita que la caché de GitHub (~5 min) devuelva una versión vieja.
    const res = await axios.get(MODPACKS_GIST_URL, {
        timeout: 10000,
        params: { t: Date.now() },
        headers: { 'Cache-Control': 'no-cache' }
    });
    let data = res.data;
    if (typeof data === 'string') data = JSON.parse(data);
    // Acepta [ {...}, {...} ], { modpacks: [...] }, { packs: [...] } o un solo objeto.
    const lista = Array.isArray(data) ? data : (data.modpacks || data.packs || [data]);
    return lista.filter(c => c && c.id && idSeguro(c.id));
}

function versionInstalada(instancePath) {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(instancePath, 'pack_info.json'), 'utf8'));
        return parseInt(d.version);
    } catch (e) { return null; }
}

function necesitaActualizarPack(instancePath, versionRemota) {
    const instalada = versionInstalada(instancePath);
    if (instalada === null || Number.isNaN(instalada)) return true; // sin pack_info válido: instalar
    return instalada < parseInt(versionRemota);
}

function sha256DeArchivo(ruta) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(ruta)
            .on('data', (d) => h.update(d))
            .on('end', () => resolve(h.digest('hex')))
            .on('error', reject);
    });
}

// Instala o actualiza el modpack. Lanza una excepción si algo falla.
async function instalarModpack(config, instancePath) {
    if (packsActualizando.has(config.id)) throw new Error('Este modpack ya se está actualizando.');
    packsActualizando.add(config.id);
    const tmp = path.join(GAME_ROOT, `pack_${idSeguro(config.id)}.zip`);
    try {
        log('Actualizando Modpack...');

        // 1. Descargar PRIMERO: si se corta la red no se toca la instalación actual.
        await descargarArchivo(config.url_modpack, tmp);
        if (config.sha256) {
            const hash = await sha256DeArchivo(tmp);
            if (hash.toLowerCase() !== String(config.sha256).trim().toLowerCase()) {
                throw new Error('El hash del modpack descargado no coincide con el del gist.');
            }
        }

        // 2. Limpiar la instalación anterior
        for (const f of ['mods', 'config', 'scripts', 'kubejs', 'defaultconfigs', 'libraries/fml']) {
            const p = path.join(instancePath, f);
            if (fs.existsSync(p)) { try { await fs.promises.rm(p, { recursive: true, force: true }); } catch (e) { } }
        }
        // Vaciar también el vault cifrado: sellarModsInstancia() MEZCLA con el
        // manifest existente y nunca borra nada, así que sin esto los mods que ya
        // no están en el pack nuevo (o sus versiones viejas) seguirían descifrándose
        // en cada partida junto a los nuevos.
        const vaultDir = vaultDirPara(instancePath);
        if (fs.existsSync(vaultDir)) {
            try { await fs.promises.chmod(vaultDir, 0o700); } catch (e) { } // ocultarCarpeta() lo deja en 0500
            await liberarCarpetaMods(vaultDir);
            await fs.promises.rm(vaultDir, { recursive: true, force: true });
        }

        // 3. Extraer e instalar (cada fase se anuncia: antes la UI se quedaba en la barra
        // de descarga al 100% mientras esto corría en silencio, parecía colgada)
        log('Descarga completa. Extrayendo modpack (puede tardar unos minutos)...');
        await extractZipAsync(tmp, instancePath);
        log('Organizando archivos del modpack...');
        const ov = path.join(instancePath, 'overrides');
        if (fs.existsSync(ov)) { await moverContenidoCarpeta(ov, instancePath); await new Promise(r => setTimeout(r, 500)); }
        await fs.promises.writeFile(path.join(instancePath, 'pack_info.json'), JSON.stringify({ version: config.version_pack }));

        // Ocultar (solo de la vista, sin quitar permisos) las carpetas que el juego
        // solo necesita LEER. Se deja fuera 'config' (muchos mods escriben ahí sus
        // ajustes) y 'saves'/'resourcepacks' (el jugador sí puede necesitarlas).
        for (const f of ['scripts', 'kubejs', 'defaultconfigs', 'libraries']) {
            const p = path.join(instancePath, f);
            if (fs.existsSync(p)) await ocultarCarpetaMods(p);
        }
        // Proteger los mods: se cifran al vault y se borra la carpeta en claro
        log('Protegiendo mods...');
        try { await sellarModsInstancia(instancePath); }
        catch (e) { log('⚠️ No se pudo sellar el vault de mods: ' + e.message); }
    } finally {
        await fs.promises.unlink(tmp).catch(() => { });
        packsActualizando.delete(config.id);
    }
}

// Consulta el gist y devuelve los modpacks INSTALADOS que tienen versión nueva.
async function comprobarActualizacionesModpacks(forzarAviso = false) {
    if (revisandoPacks) return [];
    revisandoPacks = true;
    try {
        const remotas = await obtenerConfigsRemotas();
        const pendientes = [];
        for (const cfg of remotas) {
            const ruta = rutaInstanciaSegura(cfg.id);
            if (!ruta || !cfg.url_modpack) continue;
            if (!fs.existsSync(path.join(ruta, 'pack_info.json'))) continue; // no instalado: no se descarga solo
            if (necesitaActualizarPack(ruta, cfg.version_pack)) {
                pendientes.push({
                    id: cfg.id,
                    nombre_evento: cfg.nombre_evento || cfg.id,
                    version_actual: versionInstalada(ruta),
                    version_nueva: parseInt(cfg.version_pack)
                });
            }
        }
        // Solo se avisa a la UI cuando la lista cambia (o si se fuerza), para no repetir el aviso cada 10 min.
        const firma = JSON.stringify(pendientes);
        if (pendientes.length && (forzarAviso || firma !== ultimaFirmaAvisada) && win && !win.isDestroyed()) {
            win.webContents.send('modpack-update-disponible', pendientes);
        }
        ultimaFirmaAvisada = firma;
        return pendientes;
    } catch (e) {
        console.warn('[SISTEMA]: No se pudo consultar el gist de modpacks:', e.message); // sin internet no es un error para el jugador
        return [];
    } finally {
        revisandoPacks = false;
    }
}

function iniciarVigilanteModpacks() {
    const revisar = () => { if (!jugando) comprobarActualizacionesModpacks().catch(() => { }); };
    setTimeout(revisar, 5000);
    setInterval(revisar, INTERVALO_REVISION_MS);
}

ipcMain.handle('check-modpack-updates', async () => comprobarActualizacionesModpacks(true));

ipcMain.handle('actualizar-modpack', async (e, id) => {
    if (jugando) return { success: false, error: 'No se puede actualizar mientras Minecraft está abierto.' };
    const ruta = rutaInstanciaSegura(id);
    if (!ruta) return { success: false, error: 'ID de instancia inválido' };
    try {
        // La config se vuelve a leer del gist (no se confía en lo que mande el renderer).
        const cfg = (await obtenerConfigsRemotas()).find(c => String(c.id) === String(id));
        if (!cfg || !cfg.url_modpack) return { success: false, error: 'El modpack no está en el gist.' };
        if (!necesitaActualizarPack(ruta, cfg.version_pack)) return { success: true, actualizado: false };
        if (!fs.existsSync(ruta)) await fs.promises.mkdir(ruta, { recursive: true });
        await instalarModpack(cfg, ruta);
        ultimaFirmaAvisada = '';
        return { success: true, actualizado: true, version: parseInt(cfg.version_pack) };
    } catch (err) {
        return { success: false, error: err.message };
    }
});


// =========================================================
// LANZAMIENTO INTELIGENTE
// =========================================================
// Punto de entrada IPC. Antes no había NINGUNA protección contra doble lanzamiento:
// un doble clic, o un segundo launcher abierto por error, arrancaba otra partida sobre
// la MISMA carpeta mientras la primera seguía viva. Como launcher.removeAllListeners()
// es global, la primera sesión se quedaba sin su handler de cierre (mods en claro sin
// limpiar, estado "jugando" incorrecto) y al cerrar una de las dos se borraba mods/
// debajo de la otra.
ipcMain.on('lanzar-juego', async (event, paquete) => {
    if (jugando) return enviarError("Minecraft ya está abierto", "Cierra la partida actual antes de iniciar otra.");
    if (lanzando) { log("⚠️ Ya se está preparando una partida; espera a que termine."); return; }
    lanzando = true;
    try { await lanzarJuego(paquete); }
    catch (e) { enviarError("Error inesperado", (e && e.message) || String(e)); }
    finally { lanzando = false; }
});

// Descifra los mods y comprueba su integridad. Si el vault no se puede leer (clave que ya no
// coincide, archivo corrupto, disco con errores) se reinstala el pack UNA vez automáticamente
// en lugar de dejar al jugador bloqueado con "Mods alterados". El pack oficial es la fuente
// de verdad, así que reinstalar nunca deja mods distintos a los del estudio.
async function prepararMods(config, instancePath, intento = 1) {
    try {
        await desellarModsInstancia(instancePath);
        await verificarIntegridadMods(instancePath); // corta el lanzamiento si algo fue tocado a mano
    } catch (e) {
        await limpiarModsEnClaro(instancePath).catch(() => { }); // no dejar mods sueltos/rotos en el disco
        if (intento === 1 && config.url_modpack) {
            log(`⚠️ No se pudo leer el vault de mods (${e.message}). Reinstalando el modpack automáticamente...`);
            await fs.promises.rm(path.join(instancePath, 'pack_info.json'), { force: true });
            await instalarModpack(config, instancePath);
            return prepararMods(config, instancePath, 2);
        }
        throw e;
    }
}

async function lanzarJuego(paquete) {
    const { auth, ram, config, resolucion, jvmArgs } = paquete || {};
    // NOTA: se quitó por completo la opción de jugar Minecraft vanilla.
    // El launcher solo lanza modpacks oficiales del estudio, así que se
    // ignora cualquier "esVanilla" que pudiera seguir llegando desde una
    // versión vieja de la UI y siempre se trata "config" como un modpack.
    let instancePath, versionObj;

    // 1. Configurar Carpetas
    try {
        if (!config || !config.id || !config.version_mc) {
            return enviarError("Configuración inválida", "No se seleccionó ningún modpack del estudio.");
        }
        if (!auth || !auth.name || !auth.uuid) {
            return enviarError("Sesión inválida", "No hay una sesión válida. Vuelve a iniciar sesión.");
        }
        instancePath = rutaInstanciaSegura(config.id);
        if (!instancePath) {
            return enviarError("Configuración inválida", "El id del modpack contiene caracteres no permitidos.");
        }
        const pidVivo = await juegoActivoEn(instancePath);
        if (pidVivo) {
            return enviarError("Minecraft ya está abierto", `Ya hay una partida de este modpack en ejecución (PID ${pidVivo}). Ciérrala antes de volver a jugar.`);
        }
        versionObj = { number: config.version_mc, type: "release" };
        updateDiscord('Jugando Evento', config.nombre_evento);
        if (!fs.existsSync(instancePath)) await fs.promises.mkdir(instancePath, { recursive: true });
    } catch (e) { return enviarError("Error Sistema", "No se pueden crear carpetas. " + e.message); }

    // 2. JAVA
    let javaPath = null;
    const reqJava = javaRequeridoPara(config.version_mc);
    const isWin = process.platform === "win32";
    const isMac = process.platform === "darwin";
    const so = isWin ? 'windows' : isMac ? 'mac' : 'linux';
    const javaTarget = path.join(GAME_ROOT, "runtime", "java" + reqJava);

    const findJava = async (dir) => {
        if (!fs.existsSync(dir)) return null;
        const files = await fs.promises.readdir(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            let stat;
            try { stat = await fs.promises.stat(fullPath); } catch (e) { continue; } // symlink roto
            if (stat.isDirectory()) { const r = await findJava(fullPath); if (r) return r; }
            else {
                if (isWin && file === 'java.exe') return fullPath;
                if (!isWin && file === 'java' && fullPath.includes(path.sep + 'bin' + path.sep)) return fullPath;
            }
        }
        return null;
    };

    // Comprueba que ese Java arranca de verdad y que es la versión mayor esperada.
    // Antes bastaba con que existiera "java.exe" en la carpeta: si la extracción se había
    // cortado a medias (cierre del launcher, antivirus, disco lleno) el runtime quedaba roto
    // PARA SIEMPRE, porque findJava() lo seguía encontrando y nunca se volvía a descargar.
    const javaFunciona = async (jp) => {
        try {
            const { stdout, stderr } = await execFileAsync(jp, ['-version'], { timeout: 30000, windowsHide: true });
            const m = `${stdout}\n${stderr}`.match(/version "(\d+)(?:\.(\d+))?/);
            if (!m) return false;
            return (m[1] === '1' ? m[2] : m[1]) === reqJava;
        } catch (e) { return false; }
    };

    const urlJava = () => {
        // URLs fijas (las que ya funcionaban) para Windows/Mac con 8/17/21; el resto (Java 25, Linux)
        // sale de la API oficial de Adoptium, que siempre devuelve la última build GA.
        const fijas = {
            windows: {
                "21": "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jre_x64_windows_hotspot_21.0.5_11.zip",
                "17": "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.13%2B11/OpenJDK17U-jre_x64_windows_hotspot_17.0.13_11.zip",
                "8": "https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u432-b06/OpenJDK8U-jre_x64_windows_hotspot_8u432b06.zip"
            },
            mac: {
                "21": "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jre_x64_mac_hotspot_21.0.5_11.tar.gz",
                "17": "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.13%2B11/OpenJDK17U-jre_x64_mac_hotspot_17.0.13_11.tar.gz",
                "8": "https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u432-b06/OpenJDK8U-jre_x64_mac_hotspot_8u432b06.tar.gz"
            }
        };
        const arch = (so === 'linux' && process.arch === 'arm64') ? 'aarch64' : 'x64';
        return (fijas[so] && fijas[so][reqJava]) ||
            `https://api.adoptium.net/v3/binary/latest/${reqJava}/ga/${so}/${arch}/jre/hotspot/normal/eclipse`;
    };

    // Se descarga a un archivo temporal y SOLO si eso funciona se borra el runtime anterior y se extrae.
    // Se evita renombrar la carpeta extraída: en Windows el antivirus escanea los ~50 MB recién escritos y
    // un rename de directorio falla con EPERM/EBUSY mientras alguno siga abierto. La marca ".migajas_ok" se
    // escribe al final y es lo que dice "este runtime está completo y probado".
    const marcaJava = path.join(javaTarget, '.migajas_ok');
    const instalarJava = async () => {
        const ext = isWin ? "zip" : "tar.gz";
        const tmp = path.join(GAME_ROOT, "java." + ext);
        try {
            await descargarArchivo(urlJava(), tmp);
            await fs.promises.rm(javaTarget, { recursive: true, force: true });
            await fs.promises.mkdir(javaTarget, { recursive: true });
            if (isWin) await extractZipAsync(tmp, javaTarget);
            else await execFileAsync('tar', ['-xzf', tmp, '-C', javaTarget]);
        } finally {
            await fs.promises.unlink(tmp).catch(() => { });
        }
    };

    javaPath = await findJava(javaTarget);
    const javaPrevio = javaPath; // por si hay que seguir usándolo si no se puede descargar otro
    if (javaPath && !fs.existsSync(marcaJava)) {
        // Instalación anterior a esta versión (sin marca): se comprueba UNA vez y se marca.
        // Si falla se reintenta tras una pausa (el antivirus puede estar escaneando el exe).
        let sano = await javaFunciona(javaPath);
        if (!sano) { await new Promise(r => setTimeout(r, 3000)); sano = await javaFunciona(javaPath); }
        if (sano) fs.writeFileSync(marcaJava, 'ok');
        else { log(`⚠️ El Java ${reqJava} instalado parece dañado; se reinstalará.`); javaPath = null; }
    }

    if (!javaPath) {
        log(`Descargando Java ${reqJava} para ${isWin ? "Windows" : isMac ? "Mac" : "Linux"}...`);
        try {
            await instalarJava();
            javaPath = await findJava(javaTarget);
            if (!javaPath || !(await javaFunciona(javaPath))) throw new Error("El Java descargado no se pudo ejecutar.");
            fs.writeFileSync(marcaJava, 'ok');
        } catch (e) {
            if (javaPrevio && fs.existsSync(javaPrevio)) {
                // No se pudo bajar uno nuevo: mejor intentar con el que había que dejar al jugador sin poder abrir el juego.
                log("⚠️ No se pudo reinstalar Java (" + e.message + "); se intenta con el existente.");
                javaPath = javaPrevio;
            } else {
                await fs.promises.rm(javaTarget, { recursive: true, force: true }).catch(() => { });
                return enviarError("Error Java", "Fallo descarga Java: " + e.message);
            }
        }
    }

    if (!javaPath) return enviarError("Error Java", `No se encontró el ejecutable Java ${reqJava}.`);

    // 3. MODPACK (siempre aplica: ya no existe la opción vanilla)
    if (config.url_modpack) {
        // La instalación/actualización vive ahora en instalarModpack() (ver sección
        // "ACTUALIZACIÓN AUTOMÁTICA DEL MODPACK"), compartida con el sistema que
        // vigila el gist, para que los dos caminos hagan exactamente lo mismo.
        if (packsActualizando.has(config.id)) {
            return enviarError("Modpack ocupado", "Este modpack se está actualizando, espera a que termine.");
        }
        if (necesitaActualizarPack(instancePath, config.version_pack)) {
            try { await instalarModpack(config, instancePath); }
            catch (e) { return enviarError("Error Modpack", "Fallo instalación modpack.\n" + e.message); }
        }

        // Aunque no haya habido actualización de pack, si por lo que sea quedó una
        // carpeta mods/ en claro (instalación previa a esta versión, sesión cortada
        // a la mitad, etc.), se adopta al vault ahora en vez de dejarla suelta.
        if (fs.existsSync(path.join(instancePath, 'mods'))) {
            try { await sellarModsInstancia(instancePath); }
            catch (e) { log("⚠️ No se pudo sellar mods/ existente: " + e.message); }
        }

        // Descifrar al vuelo solo para esta partida (si la instancia tiene vault)
        try { await prepararMods(config, instancePath); }
        catch (e) {
            await limpiarModsEnClaro(instancePath).catch(() => { });
            return enviarError("Mods alterados", "No se pudo verificar la integridad de los mods.\n" + e.message);
        }
    }

    // 4. OPCIONES
    // RAM: se normaliza y limita (ver calcularMemoria). Se pasa SIEMPRE en formato "<n>M":
    // MCLC solo respeta el formato si ambos valores son no numéricos o ambos numéricos.
    const mem = calcularMemoria(ram);
    mem.avisos.forEach(a => log("ℹ️ " + a));
    log(`Memoria asignada: ${mem.max} MB (inicial ${mem.min} MB).`);

    // maxSockets: 32 descargas simultáneas con wifi saturado cortaba archivos y MCLC solo
    // reintenta una vez cada uno: librerías/assets incompletos = crash al arrancar. Se baja a 8.
    const overrides = {
        detached: false, maxSockets: 8,
        assetRoot: path.join(GAME_ROOT, "assets"),
        libraryRoot: path.join(GAME_ROOT, "libraries")
    };
    // OJO: la opción de MCLC se llama customArgs; "javaArgs" NO existe y los argumentos del
    // jugador se ignoraban en silencio. Ahora se aplican, pero sanitizados.
    const { args: jvmArgsParsed, ignorados } = sanitizarJvmArgs(jvmArgs);
    if (ignorados.length) log("⚠️ Argumentos JVM ignorados (inválidos o peligrosos): " + ignorados.join(' '));
    // Estos argumentos antes NO se aplicaban (opción mal nombrada), así que hay jugadores con valores guardados
    // que nunca se probaron. Una sola opción incompatible con esta versión de Java impide que la JVM arranque
    // ("no puedo abrir Minecraft"). Se prueban en seco con `java -version` y, si fallan, se juega sin ellos.
    let customArgs = jvmArgsParsed;
    if (customArgs.length) {
        try {
            const enSeco = customArgs.filter(a => !/AlwaysPreTouch|HeapDump|Xlog|LogFile|ErrorFile/i.test(a));
            await execFileAsync(javaPath, [...enSeco, `-Xmx${mem.max}M`, '-version'], { timeout: 30000, windowsHide: true });
        } catch (e) {
            const motivo = String((e && (e.stderr || e.message)) || '').split(/\r?\n/).find(l => l.trim()) || '';
            log(`⚠️ Tus argumentos de Java no son compatibles con Java ${reqJava}; se juega sin ellos. (${motivo.trim()})`);
            customArgs = [];
        }
    }

    let opts = {
        authorization: auth,
        root: instancePath,
        version: versionObj,
        memory: { max: `${mem.max}M`, min: `${mem.min}M` },
        javaPath: javaPath,
        customArgs,
        overrides
    };
    // Igual que arriba: MCLC lee opts.window, no overrides.width/height (se ignoraban).
    const rw = parseInt(resolucion && resolucion.width), rh = parseInt(resolucion && resolucion.height);
    if (rw >= 320 && rw <= 7680 && rh >= 240 && rh <= 4320) opts.window = { width: rw, height: rh };

    // 5. LOADER (siempre aplica: ya no existe la opción vanilla)
    {
        if (config.tipo_loader === 'forge' || config.tipo_loader === 'neoforge') {
            const base = config.tipo_loader === 'neoforge' ? 'neoforge-installer' : 'forge-installer';
            if (config.url_loader) {
                // El nombre incluye un hash de la URL: antes el instalador se descargaba una sola vez
                // y NUNCA se cambiaba. Si el modpack subía de versión de Forge, los jugadores que ya
                // lo tenían seguían con el Forge viejo (crash con los mods nuevos) mientras los
                // jugadores nuevos iban bien.
                const marca = crypto.createHash('sha1').update(String(config.url_loader)).digest('hex').slice(0, 10);
                const fInst = path.join(instancePath, `${base}-${marca}.jar`);
                for (const f of await fs.promises.readdir(instancePath).catch(() => [])) {
                    if (/^(?:neo)?forge-installer.*\.jar$/.test(f) && f !== path.basename(fInst)) {
                        await fs.promises.unlink(path.join(instancePath, f)).catch(() => { });
                    }
                }
                if (!fs.existsSync(fInst)) {
                    try { log(`Descargando ${config.tipo_loader}...`); await descargarArchivo(config.url_loader, fInst); }
                    catch (e) { return enviarError("Error Loader", "Fallo descarga loader.\n" + e.message); }
                }
                opts.forge = fInst;
            } else {
                const legado = path.join(instancePath, base + '.jar');
                if (!fs.existsSync(legado)) return enviarError("Configuración", "Falta URL del loader.");
                opts.forge = legado;
            }
        } else if (config.tipo_loader === 'fabric') {
            // Prioridad: versión fijada en el gist > perfil ya instalado en la instancia > API oficial (estable).
            let fabricVer = config.fabric_version || fabricInstalado(instancePath, versionObj.number);
            if (!fabricVer) {
                try {
                    log(`Consultando versión de Fabric para ${versionObj.number}...`);
                    const res = await axios.get(`https://meta.fabricmc.net/v2/versions/loader/${versionObj.number}`, { timeout: 8000 });
                    if (res.data && res.data.length > 0) {
                        // res.data[0] puede ser una beta/inestable: se prefiere la primera marcada "stable".
                        const elegido = res.data.find(v => v.loader && v.loader.stable) || res.data[0];
                        fabricVer = `fabric-loader-${elegido.loader.version}-${versionObj.number}`;
                        log(`Usando Fabric: ${fabricVer}`);
                    }
                } catch (e) { log("⚠️ No se pudo consultar la versión de Fabric: " + e.message); }
            }
            opts.version.custom = fabricVer || `fabric-loader-0.16.9-${versionObj.number}`;
        }
    }

    // 6. LANZAR
    launcher.removeAllListeners(); // Limpiar listeners de sesiones anteriores
    launcher.on('progress', (e) => enviarProgreso(e.type, e.task, e.total));
    launcher.on('download-status', (e) => enviarProgreso('download', e.current, e.total));

    let started = false;
    let playStartTime = 0;
    let cerrado = false;           // 'close' ya se emitió (MCLC lo emite él mismo si Java no arranca)
    let ultimoFallo = '';          // última razón que MCLC dio para abortar antes de arrancar
    const inicioMs = Date.now();
    const colaLog = [];            // últimas líneas del juego, para diagnosticar un crash
    const guardarCola = (texto) => {
        for (const l of String(texto).split(/\r?\n/)) {
            if (!l) continue;
            colaLog.push(l);
            if (colaLog.length > 200) colaLog.shift();
        }
    };

    // MCLC casi nunca lanza excepciones: avisa por 'debug' y devuelve null. Sin escuchar
    // esto no había forma de saber por qué un lanzamiento no arrancaba.
    launcher.on('debug', (m) => {
        const t = redactar(m);
        escribirLog('[MCLC] ' + t.slice(0, 1500));
        if (/Failed to start|Couldn't start|not found|Failed|ENOENT|EACCES/i.test(t)) ultimoFallo = t.slice(0, 300);
    });

    // Antes: 1 mensaje IPC por cada línea de log de Forge/Fabric (puede saturar el render
    // en instancias con mucho log). Ahora se agrupan y se vuelcan cada 150ms como máximo.
    let bufferLog = [];
    let flushTimer = null;
    const flushLog = () => {
        if (bufferLog.length && win && !win.isDestroyed()) {
            win.webContents.send('consola', bufferLog.join('\n'));
        }
        bufferLog = [];
        flushTimer = null;
    };

    launcher.on('data', (e) => {
        console.log(`[SISTEMA]: ${e}`);
        guardarCola(e);
        bufferLog.push(e);
        if (!flushTimer) flushTimer = setTimeout(flushLog, 150);

        if (!started && (e.includes('LWJGL') || e.includes('OpenAL') || e.includes('Mojang') || e.includes('Sound engine'))) {
            started = true;
            playStartTime = Date.now();
            flushLog();
            log("✅ Juego iniciado correctamente");
            if (win && !win.isDestroyed()) win.hide();
        }
    });

    launcher.on('close', async (code) => {
        cerrado = true;
        if (flushTimer) clearTimeout(flushTimer);
        flushLog();
        log(`Juego cerrado (código: ${code})`);

        // --- GUARDAR PLAYTIME ---
        if (started && playStartTime > 0) {
            const playedMs = Date.now() - playStartTime;
            if (playedMs > 60000) { // Solo guarda si jugó más de 1 min
                const configId = config?.id;
                try {
                    let instances = [];
                    if (fs.existsSync(INSTANCES_FILE)) instances = JSON.parse(await fs.promises.readFile(INSTANCES_FILE, 'utf8'));
                    const idx = instances.findIndex(i => i.id === configId);
                    if (idx !== -1) {
                        instances[idx].playtime = (instances[idx].playtime || 0) + playedMs;
                    } else {
                        instances.push({ id: configId, nombre_evento: config?.nombre_evento, playtime: playedMs });
                    }
                    await fs.promises.writeFile(INSTANCES_FILE, JSON.stringify(instances, null, 2));
                    log(`⏳ Tiempo de juego actualizado.`);
                } catch (e) { log("Error guardando playtime: " + e.message); }
            }
        }

        // Volver a dejar los mods solo cifrados en el vault (nada en claro cuando no se juega)
        try { await limpiarModsEnClaro(instancePath); } catch (e) { }
        limpiarMarcaJuego(instancePath);

        started = false;
        jugando = false; // Ya se puede cerrar el launcher con normalidad
        playStartTime = 0;
        updateDiscord('En el Menú', 'Esperando...');
        setTimeout(ofrecerActualizacion, 2000); // si se encontró una versión nueva mientras se jugaba, ofrecerla ahora

        // Si salió mal, se explica por qué (y se vuelca la cola del log a launcher.log para soporte).
        const infoCrash = code !== 0 ? await construirInfoCrash(code, colaLog, instancePath, inicioMs, ultimoFallo) : null;
        if (win && !win.isDestroyed()) {
            win.show(); win.focus();
            win.webContents.send('reset-ui');
        }
        // Fuera del if de la ventana: enviarError ya comprueba win por su cuenta y, además, deja el
        // crash escrito en launcher.log aunque la ventana ya no exista.
        if (infoCrash) enviarError("Crash", infoCrash);
    });

    let proc = null;
    try { log("Lanzando Minecraft..."); proc = await launcher.launch(opts); }
    catch (e) { return enviarError("Error al Lanzar", e.message); }

    if (!proc) {
        // MCLC devuelve null (sin excepción) si falla ANTES de arrancar: versión/loader no encontrado,
        // fallo de red bajando librerías, etc. Antes no se miraba el resultado y la UI se quedaba
        // en "Lanzando" para siempre. Si fue por Java inválido, MCLC ya emitió 'close' y el handler
        // de arriba ya informó del error, así que no se duplica.
        if (!cerrado) enviarError("No se pudo iniciar", ultimoFallo || "El juego no arrancó. Revisa launcher.log o usa \"Reparar instancia\".");
        return;
    }

    // Sin listener de 'error', un fallo al crear el proceso (EPERM por antivirus, EACCES...) tumbaba el launcher entero.
    proc.on('error', (err) => escribirLog(`ERROR proceso Java: ${err.message}`));
    // Se marca como "jugando" en cuanto el proceso existe (antes solo al ver cierto texto en el log: si el
    // texto no aparecía, se podía cerrar el launcher con el juego vivo y romper su salida estándar).
    jugando = true;
    if (proc.pid) marcarJuegoActivo(instancePath, proc.pid);
}