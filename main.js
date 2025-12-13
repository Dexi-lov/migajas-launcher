const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip'); 
const axios = require('axios'); 
const FormData = require('form-data');
const crypto = require('crypto');
// Necesario para descomprimir en Mac
const { execSync } = require('child_process');

// --- SETUP ---
let DiscordRPC, rpcClient, tieneDiscord = false;
try { DiscordRPC = require('discord-rpc'); tieneDiscord = true; } catch (e) {}
const launcher = new Client();
let win, splash;
const clientId = '1411570545190899822'; 

// =========================================================
// RUTA DE DATOS SEGURA
// =========================================================
const GAME_ROOT = path.join(app.getPath('userData'), '.migajas_mc');

// --- AUTOLIMPIEZA DE ARRANQUE ---
try {
    if (fs.existsSync(GAME_ROOT)) {
        const stats = fs.statSync(GAME_ROOT);
        if (!stats.isDirectory()) {
            try { fs.unlinkSync(GAME_ROOT); } catch(e){}
        }
    }
    if (!fs.existsSync(GAME_ROOT)) fs.mkdirSync(GAME_ROOT, { recursive: true });
} catch (e) { console.error("Error validando root:", e); }

// --- UTILS ---
function log(msg) {
    console.log(`[SISTEMA]: ${msg}`);
    if (win && !win.isDestroyed()) win.webContents.send('consola', msg);
}

function enviarError(titulo, mensaje) {
    if (win && !win.isDestroyed()) {
        win.webContents.send('error-lanzamiento', { titulo, mensaje });
        win.webContents.send('reset-ui');
    }
}

function enviarProgreso(tipo, task, total) {
    if (win && !win.isDestroyed()) {
        win.webContents.send('progreso', { type: tipo, task: task, total: total });
    }
}

function updateDiscord(estado, detalles) {
    if (!tieneDiscord || !rpcClient) return;
    rpcClient.setActivity({ details: detalles, state: estado, largeImageKey: 'logo_grande', largeImageText: 'Migajas', instance: false }).catch(()=>{});
}

// --- MOTOR DE DESCARGAS ---
async function descargarArchivo(url, destino) {
    if (!url) throw new Error("URL vacía");
    let urlFinal = url;
    if (url.includes('dropbox.com')) urlFinal = url.replace("www.dropbox.com", "dl.dropboxusercontent.com").replace("?dl=1", "").replace("&dl=1", "");
    
    const dir = path.dirname(destino);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const writer = fs.createWriteStream(destino);
    try {
        const response = await axios({ url: urlFinal, method: 'GET', responseType: 'stream', maxRedirects: 5, timeout: 60000 });
        const total = parseInt(response.headers['content-length'], 10);
        response.data.pipe(writer);
        
        return new Promise((resolve, reject) => {
            let downloaded = 0, lastUpd = 0;
            response.data.on('data', (c) => {
                downloaded += c.length;
                const now = Date.now();
                if(now - lastUpd > 100 && total) { enviarProgreso('download', downloaded, total); lastUpd = now; }
            });
            writer.on('finish', () => setTimeout(resolve, 500));
            writer.on('error', reject);
        });
    } catch (e) { throw new Error(`Fallo descarga: ${e.message}`); }
}

function moverContenidoCarpeta(origen, destino) {
    if (!fs.existsSync(destino)) fs.mkdirSync(destino, { recursive: true });
    fs.readdirSync(origen).forEach(el => {
        const src = path.join(origen, el);
        const dest = path.join(destino, el);
        if (fs.lstatSync(src).isDirectory()) moverContenidoCarpeta(src, dest);
        else { if (fs.existsSync(dest)) fs.unlinkSync(dest); fs.renameSync(src, dest); }
    });
    try { fs.rmdirSync(origen); } catch (e) {} 
}

// --- WINDOWS ---
function createWindow() {
    // CAMBIO: Usar icon.png en lugar de icon.ico
    splash = new BrowserWindow({ width: 300, height: 400, transparent: true, frame: false, alwaysOnTop: true, center: true, icon: path.join(__dirname, 'icon.png') });
    splash.loadFile('splash.html');
    
    // CAMBIO: Usar icon.png en lugar de icon.ico
    win = new BrowserWindow({ width: 1000, height: 650, title: "Migajas Launcher", frame: false, show: false, backgroundColor: '#0f0f0f', icon: path.join(__dirname, 'icon.png'), webPreferences: { nodeIntegration: true, contextIsolation: false } });
    win.loadFile('index.html');
    win.once('ready-to-show', () => { setTimeout(() => { if(splash) splash.close(); win.show(); win.focus(); }, 2500); });
}
app.whenReady().then(() => { createWindow(); if(tieneDiscord){ try{ rpcClient=new DiscordRPC.Client({transport:'ipc'}); rpcClient.login({clientId}).catch(()=>{}); }catch(e){} } });

// --- API IPC ---
ipcMain.handle('login-microsoft', async () => {
    try {
        const authManager = new Auth("select_image");
        const xboxManager = await authManager.launch("electron");
        const token = await xboxManager.getMinecraft();
        return { success: true, profile: token.mclc() };
    } catch (e) { return { success: false, error: e.message }; }
});

// FIX OFFLINE 1.21+
ipcMain.handle('login-offline', (e, nick) => {
    return {
        access_token: "null",
        client_token: "null",
        uuid: crypto.randomUUID(), 
        name: nick,
        user_properties: {}, 
        meta: { type: "mojang", demo: false }
    };
});

ipcMain.handle('check-instancia', (e, id) => { 
    const p = path.join(GAME_ROOT, "instances", id||"default"); 
    return fs.existsSync(p) && fs.readdirSync(p).length > 0; 
});

ipcMain.handle('borrar-instancia', (e, id) => { 
    try { 
        const p = path.join(GAME_ROOT, "instances", id||"default"); 
        if(fs.existsSync(p)) fs.rmSync(p, {recursive:true, force:true}); 
        return {success:true}; 
    } catch(e) { return {success:false, error:e.message}; } 
});

ipcMain.on('abrir-carpeta', (e, id) => { 
    const p = path.join(GAME_ROOT, "instances", id||"default"); 
    if(!fs.existsSync(p)) fs.mkdirSync(p, {recursive:true}); shell.openPath(p); 
});

ipcMain.handle('cambiar-skin', async (e, { token, imageBuffer, modelo }) => {
    try {
        const img = Buffer.from(imageBuffer.split(',')[1], 'base64');
        const d = new FormData(); d.append("variant", modelo); d.append("file", img, { filename: 'skin.png' });
        await axios.post("https://api.minecraftservices.com/minecraft/profile/skins", d, { headers: { "Authorization": `Bearer ${token}`, ...d.getHeaders() } });
        return { success: true };
    } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('get-version', () => app.getVersion());
ipcMain.on('cerrar-app', () => app.quit());
ipcMain.on('minimizar-app', () => win.minimize());

// ================= LANZAMIENTO INTELIGENTE =================
ipcMain.on('lanzar-juego', async (event, paquete) => {
    const { auth, ram, config, esVanilla } = paquete;
    let instancePath, versionObj;

    // 1. Configurar Carpetas
    try {
        if (esVanilla) {
            instancePath = path.join(GAME_ROOT, "instances", "standard");
            versionObj = { number: config.version, type: "release" };
            updateDiscord('Jugando', `Minecraft ${config.version}`);
        } else {
            instancePath = path.join(GAME_ROOT, "instances", config.id || "event");
            versionObj = { number: config.version_mc, type: "release" };
            updateDiscord('Jugando Evento', config.nombre_evento);
        }
        if (!fs.existsSync(instancePath)) fs.mkdirSync(instancePath, { recursive: true });
    } catch (e) { return enviarError("Error Sistema", "No se pueden crear carpetas. " + e.message); }

    // 2. JAVA (SOPORTE MAC + WINDOWS)
    let javaPath = null;
    const verNum = parseFloat(esVanilla ? config.version.substring(0, 4) : config.version_mc.substring(0, 4));
    
    // Reglas de versión
    let reqJava = "8";
    if (verNum >= 1.21) reqJava = "21";
    else if (verNum >= 1.18) reqJava = "17"; 
    else if (verNum >= 1.17) reqJava = "17";
    else reqJava = "8";

    // Detectar Sistema Operativo
    const isWin = process.platform === "win32";
    const isMac = process.platform === "darwin";

    const javaRoot = path.join(GAME_ROOT, "runtime");
    const javaTarget = path.join(javaRoot, "java" + reqJava);

    // Función búsqueda recursiva
    const findJava = (dir) => { 
        if (!fs.existsSync(dir)) return null;
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                const r = findJava(fullPath);
                if (r) return r;
            } else {
                // En Windows es java.exe, en Mac es solo java
                if (isWin && file === 'java.exe') return fullPath;
                if (isMac && file === 'java' && fullPath.includes('/bin/')) return fullPath;
            }
        }
        return null;
    };

    javaPath = findJava(javaTarget);

    if (!javaPath) {
        log(`Descargando Java ${reqJava} para ${isWin?"Windows":"Mac"}...`);
        let urlJ = "";

        // URLs de descarga según S.O.
        if (isWin) {
            if(reqJava === "21") urlJ = "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.1%2B12/OpenJDK21U-jre_x64_windows_hotspot_21.0.1_12.zip";
            else if(reqJava === "17") urlJ = "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.10%2B7/OpenJDK17U-jre_x64_windows_hotspot_17.0.10_7.zip";
            else urlJ = "https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u402-b06/OpenJDK8U-jre_x64_windows_hotspot_8u402b06.zip";
        } else if (isMac) {
            // URLs Mac (tar.gz)
            if(reqJava === "21") urlJ = "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.1%2B12/OpenJDK21U-jre_x64_mac_hotspot_21.0.1_12.tar.gz";
            else if(reqJava === "17") urlJ = "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.10%2B7/OpenJDK17U-jre_x64_mac_hotspot_17.0.10_7.tar.gz";
            else urlJ = "https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u402-b06/OpenJDK8U-jre_x64_mac_hotspot_8u402b06.tar.gz";
        }

        const ext = isWin ? "zip" : "tar.gz";
        const tmp = path.join(GAME_ROOT, "java." + ext);
        
        try {
            if(!fs.existsSync(javaTarget)) fs.mkdirSync(javaTarget, {recursive:true});
            await descargarArchivo(urlJ, tmp);
            
            // Extracción Inteligente
            if (isWin) {
                const z = new AdmZip(tmp); z.extractAllTo(javaTarget, true);
            } else {
                // En Mac usamos el comando nativo 'tar' porque adm-zip falla con permisos
                log("Descomprimiendo en Mac...");
                execSync(`tar -xzf "${tmp}" -C "${javaTarget}"`);
            }
            
            fs.unlinkSync(tmp);
            javaPath = findJava(javaTarget);
        } catch(e) { return enviarError("Error Java", "Fallo descarga Java: " + e.message); }
    }

    if (!javaPath) return enviarError("Error Java", `No se encontró el ejecutable Java.`);

    // 3. MODPACK
    if (!esVanilla && config.url_modpack) {
        const infoFile = path.join(instancePath, "pack_info.json");
        let update = false;

        if (!fs.existsSync(infoFile)) {
            update = true;
        } else {
            try {
                const d = JSON.parse(fs.readFileSync(infoFile));
                if (parseInt(d.version) < parseInt(config.version_pack)) update = true;
            } catch (e) { update = true; }
        }

        if (update) {
            log(`Actualizando Modpack...`);
            try {
                ['mods', 'config', 'scripts', 'kubejs', 'defaultconfigs', 'libraries/fml'].forEach(f => {
                    const p = path.join(instancePath, f);
                    if(fs.existsSync(p)) { try { fs.rmSync(p, {recursive:true, force:true}); } catch(e){} }
                });

                const tmp = path.join(GAME_ROOT, "pack.zip");
                await descargarArchivo(config.url_modpack, tmp);
                const z = new AdmZip(tmp); z.extractAllTo(instancePath, true); fs.unlinkSync(tmp);
                
                const ov = path.join(instancePath, "overrides");
                if (fs.existsSync(ov)) { 
                    moverContenidoCarpeta(ov, instancePath); 
                    await new Promise(r => setTimeout(r, 500)); 
                }
                fs.writeFileSync(infoFile, JSON.stringify({ version: config.version_pack }));
            } catch(e) { return enviarError("Error Modpack", "Fallo instalación modpack.\n" + e.message); }
        }
    }

    // 4. OPCIONES
    let opts = {
        authorization: auth,
        root: instancePath,
        version: versionObj,
        memory: { max: ram, min: "2G" },
        javaPath: javaPath,
        overrides: { 
            detached: false, 
            maxSockets: 32, 
            assetRoot: path.join(GAME_ROOT, "assets"),
            libraryRoot: path.join(GAME_ROOT, "libraries")
        }
    };

    // 5. LOADER
    if (!esVanilla) {
        if (config.tipo_loader === 'forge' || config.tipo_loader === 'neoforge') {
            const fName = config.tipo_loader === 'neoforge' ? 'neoforge-installer.jar' : 'forge-installer.jar';
            const fInst = path.join(instancePath, fName);
            if (!fs.existsSync(fInst)) {
                if (config.url_loader) {
                    try {
                        log(`Descargando ${config.tipo_loader}...`);
                        await descargarArchivo(config.url_loader, fInst);
                    } catch(e) { return enviarError("Error Loader", "Fallo descarga loader."); }
                } else { return enviarError("Configuración", "Falta URL del loader."); }
            }
            opts.forge = fInst;
        } else if (config.tipo_loader === 'fabric') {
            opts.version.custom = "fabric-loader";
        }
    }

    // 6. LANZAR
    launcher.on('progress', (e) => enviarProgreso(e.type, e.task, e.total));
    launcher.on('download-status', (e) => enviarProgreso('download', e.current, e.total));

    let started = false;
    launcher.on('data', (e) => {
        if (!started && (e.includes('LWJGL') || e.includes('OpenAL') || e.includes('Mojang') || e.includes('Sound engine'))) {
            started = true; log("Juego Iniciado"); win.hide();
        }
    });

    launcher.on('close', (code) => { 
        log(`Juego cerrado (${code})`);
        started = false; updateDiscord('En el Menú', 'Esperando...'); 
        win.show(); win.focus(); win.webContents.send('reset-ui'); 
        if(code !== 0) enviarError("Crash", `El juego se cerró inesperadamente (Código ${code}).`);
    });

    try { log("Lanzando..."); await launcher.launch(opts); } 
    catch (e) { enviarError("Error al Lanzar", e.message); }
});