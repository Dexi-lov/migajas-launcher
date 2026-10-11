// =========================================================
// PRELOAD — puente seguro entre el renderer (index.html) y el proceso
// principal (main.js).
// =========================================================
// Con contextIsolation:true + nodeIntegration:false (ver createWindow en
// main.js), index.html YA NO tiene acceso a require('electron') ni a Node.
// Este archivo es el ÚNICO lugar donde se decide qué puede pedir el
// renderer: se expone una API mínima y con nombre concreto (nada de pasar
// ipcRenderer entero), así que aunque el renderer se viera comprometido por
// un XSS, lo máximo que podría hacer es llamar a estas funciones concretas,
// no ejecutar código Node arbitrario.
//
// NOTA PARA QUIEN INTEGRE ESTO: el index.html / renderer.js actual
// probablemente use `require('electron').ipcRenderer` directamente (porque
// antes nodeIntegration estaba activado). Hace falta cambiar esas llamadas
// por `window.launcherAPI.xxx(...)`. Los nombres de abajo cubren todos los
// canales que main.js usa; si el renderer real usa otros no listados aquí,
// hay que añadirlos siguiendo el mismo patrón.

const { contextBridge, ipcRenderer } = require('electron');

// Envuelve ipcRenderer.on para que el renderer reciba un callback normal
// y pueda des-suscribirse, sin exponerle el objeto ipcRenderer real.
function suscribir(canal) {
    return (callback) => {
        const listener = (_event, ...args) => callback(...args);
        ipcRenderer.on(canal, listener);
        return () => ipcRenderer.removeListener(canal, listener);
    };
}

contextBridge.exposeInMainWorld('launcherAPI', {
    // --- Autenticación ---
    loginMicrosoft: () => ipcRenderer.invoke('login-microsoft'),
    loginMicrosoftSilent: () => ipcRenderer.invoke('login-microsoft-silent'),
    logoutMicrosoft: () => ipcRenderer.invoke('logout-microsoft'),
    loginOffline: (nick) => ipcRenderer.invoke('login-offline', nick),

    // --- Instancias / modpacks ---
    getInstances: () => ipcRenderer.invoke('get-instances'),
    checkInstancia: (id) => ipcRenderer.invoke('check-instancia', id),
    borrarInstancia: (id) => ipcRenderer.invoke('borrar-instancia', id),
    abrirCarpeta: (id) => ipcRenderer.send('abrir-carpeta', id),
    repairInstance: (id) => ipcRenderer.invoke('repair-instance', id),
    exportInstance: (id) => ipcRenderer.invoke('export-instance', id),

    // --- Skins ---
    cambiarSkin: (payload) => ipcRenderer.invoke('cambiar-skin', payload),

    // --- Sistema / info ---
    getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
    pingServidor: (ip) => ipcRenderer.invoke('ping-servidor', ip),
    getFabricVersion: (mcVersion) => ipcRenderer.invoke('get-fabric-version', mcVersion),
    getVersion: () => ipcRenderer.invoke('get-version'),

    // --- Mods (stubs deshabilitados a propósito, ver main.js) ---
    getMods: () => ipcRenderer.invoke('get-mods'),
    toggleMod: (payload) => ipcRenderer.invoke('toggle-mod', payload),

    // --- Ventana / app ---
    cerrarApp: () => ipcRenderer.send('cerrar-app'),
    minimizarApp: () => ipcRenderer.send('minimizar-app'),

    // --- Lanzamiento del juego ---
    lanzarJuego: (paquete) => ipcRenderer.send('lanzar-juego', paquete),

    // --- Auto-actualización ---
    updaterAction: (accion) => ipcRenderer.send('updater-action', accion),

    // --- Eventos que manda el proceso principal (devuelven función para des-suscribirse) ---
    onConsola: suscribir('consola'),
    onErrorLanzamiento: suscribir('error-lanzamiento'),
    onResetUi: suscribir('reset-ui'),
    onProgreso: suscribir('progreso'),
    onUpdaterEvent: suscribir('updater-event')
});