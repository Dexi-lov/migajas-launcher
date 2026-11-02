// =========================================================
// PRELOAD Tauri — puente de compatibilidad con la API de Electron
// =========================================================
// Este archivo expone la misma API launcherAPI que usaba el frontend
// con Electron, pero adaptada para funcionar con Tauri v2.

// Esperar a que Tauri esté disponible
if (typeof window.__TAURI__ === 'undefined') {
    console.error('Tauri no está disponible. Asegúrate de ejecutar con tauri dev o tauri build');
} else {
    const { invoke } = window.__TAURI__.core;
    const { listen } = window.__TAURI__.event;

    // Función auxiliar para suscribirse a eventos Tauri
    function suscribir(canal) {
        return (callback) => {
            const unlisten = listen(canal, (event) => callback(event.payload));
            return () => unlisten.then(fn => fn());
        };
    }

    // API de compatibilidad con el preload.js original de Electron
    window.launcherAPI = {
        // --- Autenticación ---
        loginMicrosoft: () => invoke('auth_login_microsoft'),
        loginMicrosoftSilent: (uuid) => invoke('auth_restore_session', uuid ? { uuid } : null),
        logoutMicrosoft: (uuid) => invoke('auth_logout', { uuid }),
        loginOffline: (nick) => invoke('auth_login_offline', { username: nick }),

        // --- Instancias / modpacks ---
        getInstances: () => invoke('get_instances'),
        checkInstancia: (id) => invoke('check_instancia', id),
        borrarInstancia: (id) => invoke('borrar_instancia', id),
        abrirCarpeta: (id) => invoke('abrir_carpeta', id),
        repairInstance: (id) => invoke('instance_sync', { req: { instanceId: id, forceRepair: true } }),
        syncInstance: (manifest, downloadLimitKbps = 0) => invoke('instance_sync', {
            req: {
                instanceId: manifest.id,
                forceRepair: false,
                urlModpack: manifest.url_modpack,
                versionPack: Number.parseInt(manifest.version_pack, 10) || 1,
                downloadLimitKbps: Number.parseInt(downloadLimitKbps, 10) || 0,
                manifest
            }
        }),
        cancelInstanceSync: (instanceId) => invoke('instance_cancel_sync', { instanceId }),
        exportInstance: (id) => invoke('export_instance', id),
        checkInstanceWhitelist: (instanceId, profileUuid, username) =>
            invoke('check_instance_whitelist', { instanceId, profileUuid, username }),
        isMigajasInstance: (instanceId) => invoke('is_migajas_instance', { instanceId }),
        deleteInstance: (instanceId) => invoke('delete_instance', { instanceId }),
        listLocalInstances: () => invoke('list_local_instances'),
        deletePreviousInstance: (instanceId) => invoke('delete_previous_instance', { instanceId }),
        getGameOptions: (instanceId) => invoke('get_game_options', { instanceId }),
        saveGameOptions: (instanceId, options) => invoke('save_game_options', { instanceId, options }),
        listResourcePacks: (instanceId) => invoke('list_resourcepacks', { instanceId }),
        gistConnect: (token) => invoke('gist_connect', { token }),
        gistEditorStatus: () => invoke('gist_editor_status'),
        gistReadEvents: () => invoke('gist_read_events'),
        gistPublishEvents: (content) => invoke('gist_publish_events', { content }),
        gistDisconnect: () => invoke('gist_disconnect'),
        gistAdminCodeStatus: () => invoke('gist_admin_code_status'),
        gistSetAdminCode: (code, currentCode = null) => invoke('gist_set_admin_code', { code, currentCode }),
        gistVerifyAdminCode: (code) => invoke('gist_verify_admin_code', { code }),
        gistGetLauncherWhitelist: () => invoke('gist_get_launcher_whitelist'),
        gistPublishLauncherWhitelist: (payload) => invoke('gist_publish_launcher_whitelist', payload),

        getScreenshots: (instanceId, offset = 0) => invoke('get_screenshots', { instanceId, offset, limit: 48 }),
        getScreenshotImage: (instanceId, fileName) => invoke('get_screenshot_image', { instanceId, fileName }),
        openScreenshotFolder: (instanceId) => invoke('open_screenshot_folder', { instanceId }),
        deleteScreenshot: (instanceId, fileName) => invoke('delete_screenshot', { instanceId, fileName }),

        // --- Skins ---
        cambiarSkin: (payload) => invoke('auth_upload_skin', {
            uuid: payload.uuid,
            imageDataUrl: payload.imageDataUrl,
            model: payload.model,
        }),

        // --- Sistema / info ---
        getSystemInfo: () => invoke('get_system_info'),
        pingServidor: (ip) => invoke('ping_servidor', ip),
        getFabricVersion: (mcVersion) => invoke('get_fabric_version', mcVersion),
        getVersion: () => invoke('get_version'),

        // --- Mods (stubs deshabilitados a propósito) ---
        getMods: () => invoke('get_mods'),
        toggleMod: (payload) => invoke('toggle_mod', payload),

        // --- Ventana / app ---
        cerrarApp: () => window.__TAURI__.window.getCurrentWindow().close(),
        minimizarApp: () => window.__TAURI__.window.getCurrentWindow().minimize(),
        maximizarApp: () => window.__TAURI__.window.getCurrentWindow().toggleMaximize(),
        isWindowMaximized: () => window.__TAURI__.window.getCurrentWindow().isMaximized(),
        openDiscordInvite: () => invoke('open_discord_invite'),

        // --- Lanzamiento del juego ---
        lanzarJuego: (paquete) => {
            const ramGb = Number.parseInt(String(paquete.ram || '4G').replace(/[^0-9]/g, ''), 10) || 4;
            const jvmArgs = Array.isArray(paquete.jvmArgs)
                ? paquete.jvmArgs
                : String(paquete.jvmArgs || '').split(/\s+/).filter(Boolean);
            return invoke('game_launch', {
                config: {
                    instanceId: paquete.config?.id,
                    profileUuid: paquete.auth?.uuid,
                    versionMc: paquete.config?.version_mc,
                    tipoLoader: paquete.config?.tipo_loader,
                    loaderVersion: paquete.config?.loader_version || paquete.config?.fabric_version,
                    urlLoader: paquete.config?.url_loader,
                    javaVersion: paquete.config?.java_version,
                    memoryMb: { min: 1024, max: ramGb * 1024 },
                    resolution: paquete.resolucion
                        ? { width: paquete.resolucion.width, height: paquete.resolucion.height, fullscreen: false }
                        : null,
                    customJvmArgs: jvmArgs,
                    closeLauncherOnStart: paquete.cerrarAlLanzar ? 'hide' : 'keep_open'
                }
            });
        },

        // --- Auto-actualización ---
        updaterCheck: () => invoke('updater_check'),
        updaterInstall: () => invoke('updater_install'),

        // --- Eventos que manda el proceso principal ---
        onConsola: suscribir('consola'),
        onErrorLanzamiento: suscribir('error-lanzamiento'),
        onResetUi: suscribir('reset-ui'),
        onProgreso: suscribir('progreso'),
        onUpdaterEvent: suscribir('updater-event'),
        onUpdaterProgress: suscribir('updater-progress'),
        onUpdaterDownloaded: suscribir('updater-downloaded'),

        // --- Nuevos eventos del motor Rust ---
        onSyncProgress: suscribir('sync://progress'),
        onInstallProgress: suscribir('game://install-progress'),
        onGameLogBatch: suscribir('game://log-batch'),
        onGameStateChanged: suscribir('game://state-changed'),
        onGameCrashed: suscribir('game://crashed'),
        onAuthDeviceCode: suscribir('auth://device-code')
    };

    console.log('launcherAPI cargado (Tauri compatibility layer)');
}
