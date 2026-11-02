/* ═══════════════════════════════════════════════════════════════════
       MIGAJAS LAUNCHER — APP LOGIC
       ═══════════════════════════════════════════════════════════════════ */

    const AVATAR_PLACEHOLDER =
        "data:image/svg+xml;base64," +
        btoa('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
             '<rect width="64" height="64" fill="#2b2b2b"/>' +
             '<rect x="16" y="16" width="32" height="32" fill="#555"/></svg>');

    /* ───────────── STATE ───────────── */
    const state = {
        creds: null,
        events: [],
        allEvents: [],
        launcherWhitelistEnabled: false,
        instanceAccessError: '',
        whitelistAdminUnlocked: false,
        whitelistAdminCode: '',
        whitelistAdminCodeConfigured: false,
        selectedInstance: null,
        localInstances: [],
        instanceGameOptions: null,
        activeInstanceSettingsId: null,
        socialHeartbeat: null,
        socialRefreshTimer: null,
        socialRefreshInFlight: false,
        socialLastActivityAt: Date.now(),
        socialActivityTracking: false,
        socialFriends: [],
        socialRequestCount: 0,
        activeGameInstanceId: null,
        tutorialStep: null,
        pendingControlBinding: null,
        bindingPointerCaptured: false,
        contextInstanceId: null,
        currentView: 'instances',
        skinModel: 'default',
        pendingSkinTexture: null,
        skinViewer: null,
        lastProgress: { task: 0, time: 0 },
        theme: null,
    };

    /* ───────────── HELPERS ───────────── */
    function $(sel, root = document) { return root.querySelector(sel); }
    function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

    async function safeCall(fn, fallback) {
        try { return await fn(); } catch (e) { return fallback; }
    }

    function escapeHtml(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    const THEME_PRESETS = {
        cacao: { accent: '#e2a64a', background: '#100e0b' },
        carmesi: { accent: '#e04450', background: '#100e0b' },
        oceano: { accent: '#55afd0', background: '#0b1117' },
        bosque: { accent: '#75bd7d', background: '#0c130f' },
        lavanda: { accent: '#ad91e8', background: '#110e17' },
    };

    function validHexColor(value, fallback) {
        return /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
    }

    function accentForeground(hex) {
        const rgb = hex.match(/[0-9a-f]{2}/gi).map(value => parseInt(value, 16) / 255);
        const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return (0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]) > 0.42 ? '#17120c' : '#ffffff';
    }

    function mixHex(color, target, amount) {
        const from = color.match(/[0-9a-f]{2}/gi).map(v => parseInt(v, 16));
        const to = target.match(/[0-9a-f]{2}/gi).map(v => parseInt(v, 16));
        return '#' + from.map((v, i) => Math.round(v + (to[i] - v) * amount).toString(16).padStart(2, '0')).join('');
    }

    function applyTheme(theme, persist = true) {
        const accent = validHexColor(theme?.accent, THEME_PRESETS.cacao.accent);
        const background = validHexColor(theme?.background, THEME_PRESETS.cacao.background);
        state.theme = { accent, background };
        const root = document.documentElement;
        root.style.setProperty('--accent-red', accent);
        root.style.setProperty('--accent-red-hover', mixHex(accent, '#ffffff', 0.16));
        root.style.setProperty('--accent-red-glow', `color-mix(in srgb, ${accent} 42%, transparent)`);
        root.style.setProperty('--accent-foreground', accentForeground(accent));
        root.style.setProperty('--bg-darker', background);
        root.style.setProperty('--bg-dark', mixHex(background, '#ffffff', 0.045));
        root.style.setProperty('--bg-panel', mixHex(background, '#ffffff', 0.075));
        root.style.setProperty('--bg-elevated', mixHex(background, '#ffffff', 0.11));
        root.style.setProperty('--accent-soft', `color-mix(in srgb, ${accent} 15%, transparent)`);
        root.style.setProperty('--accent-border', `color-mix(in srgb, ${accent} 34%, transparent)`);
        if (persist) localStorage.setItem('migajasTheme', JSON.stringify(state.theme));
        $('#theme-accent-color').value = accent;
        $('#theme-background-color').value = background;
        updateThemePresetSelection();
    }

    function updateThemePresetSelection() {
        $$('[data-theme-preset]').forEach(button => {
            const preset = THEME_PRESETS[button.dataset.themePreset];
            const selected = preset && preset.accent === state.theme?.accent && preset.background === state.theme?.background;
            button.setAttribute('aria-pressed', String(Boolean(selected)));
        });
    }

    function initThemeSettings() {
        let saved;
        try { saved = JSON.parse(localStorage.getItem('migajasTheme') || 'null'); } catch (_) { saved = null; }
        applyTheme(saved || THEME_PRESETS.cacao, false);
        $$('[data-theme-preset]').forEach(button => {
            button.addEventListener('click', () => applyTheme(THEME_PRESETS[button.dataset.themePreset]));
        });
        ['theme-accent-color', 'theme-background-color'].forEach(id => {
            $('#' + id)?.addEventListener('input', () => applyTheme({
                accent: $('#theme-accent-color').value,
                background: $('#theme-background-color').value,
            }));
        });
    }

    /* ───────────── SPLASH + BOOT ───────────── */
    document.addEventListener('DOMContentLoaded', async () => {
        initCriticalControls();
        initThemeSettings();
        const intentoSesion = (window.launcherAPI?.loginMicrosoftSilent?.() ?? Promise.resolve({ success: false }))
            .catch(() => ({ success: false }));

        setTimeout(async () => {
            const splash = $('#splash-screen');
            const sesion = await intentoSesion;

            splash.classList.add('hide');
            setTimeout(() => { splash.style.display = 'none'; }, 800);

            if (sesion && sesion.success && sesion.profile) {
                await setCredentials(sesion.profile);
            } else {
                showScreen('screen-login');
                $('.login-box')?.classList.add('show');
            }
        }, 2200);

        const v = await safeCall(() => window.launcherAPI.getVersion(), null);
        if (v) $('#app-version').textContent = 'v' + v;

        try {
            const canvas = $('#skin-canvas');
            if (canvas && window.skinview3d) {
                state.skinViewer = new window.skinview3d.SkinViewer({
                    canvas,
                    width: 220,
                    height: 340,
                    zoom: 0.85
                });
                state.skinViewer.autoRotate = true;
            }
        } catch (e) { console.warn('[skinview3d]', e); }

        initSidebarHandlers();
        initDrawerHandlers();
        initSkinModalHandlers();
        initInstanceContextMenu();
        initInstanceSettingsModalHandlers();
        initTutorialHandlers();
        initSettingsModalHandlers();
        initLauncherUpdater();
        initGistEditorHandlers();
        initLaunchHandlers();
        initInstancesSearch();
        initParticles();
        wireTauriEvents();
        if (localStorage.getItem('migajasAutoupdate') !== '0' && typeof window.launcherAPI?.updaterCheck === 'function') {
            setTimeout(() => checkLauncherUpdate(false), 7000);
        }
    });

    /* ═══════════════════════════════════════════════════════════════════
       LOGIN / LOGOUT
       ═══════════════════════════════════════════════════════════════════ */
    function showScreen(id) {
        $$('.screen').forEach(s => s.classList.remove('active'));
        const target = document.getElementById(id);
        if (!target) return;
        target.classList.add('active');
    }

    function initCriticalControls() {
        const report = error => { $('#login-status').textContent = error?.message || String(error); };
        const updateWindowButtons = async () => {
            try {
                const maximized = await window.launcherAPI?.isWindowMaximized?.();
                for (const button of $$('[data-window-action="maximize"]')) {
                    button.title = maximized ? 'Restaurar ventana' : 'Maximizar ventana';
                    button.setAttribute('aria-label', button.title);
                    button.setAttribute('aria-pressed', String(Boolean(maximized)));
                    button.querySelector('path')?.setAttribute('d', maximized ? 'M4 1H11V8M1 4H8V11H1Z' : 'M1 1H11V11H1Z');
                }
            } catch (error) { report(error); }
        };
        for (const control of $$('[data-window-action]')) {
            control.addEventListener('click', async () => {
                try {
                    const action = { close: 'cerrarApp', minimize: 'minimizarApp', maximize: 'maximizarApp' }[control.dataset.windowAction];
                    if (typeof window.launcherAPI?.[action] !== 'function') throw new Error('No se pudo conectar con la ventana del launcher.');
                    await window.launcherAPI[action]();
                    if (control.dataset.windowAction === 'maximize') await updateWindowButtons();
                } catch (error) { report(error); }
            });
        }
        window.addEventListener('resize', updateWindowButtons);
        void updateWindowButtons();
        $('#login-microsoft').addEventListener('click', loginMicrosoft);
        $('#login-offline-toggle').addEventListener('click', toggleOfflineForm);
        $('#login-offline-submit').addEventListener('click', loginOffline);
        $('#nick-input').addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); loginOffline(); }
        });
        $('#hero-logo').addEventListener('error', () => { $('#hero-logo').style.display = 'none'; });
    }

    function toggleOfflineForm() {
        const form = $('#offline-form');
        if (!form) return;
        form.hidden = !form.hidden;
    }

    let loginBusy = false;
    async function performLogin(method, argument) {
        if (loginBusy) return;
        loginBusy = true;
        const controls = [$('#login-microsoft'), $('#login-offline-submit')];
        controls.forEach(control => control.disabled = true);
        const status = $('#login-status');
        status.textContent = method === 'loginMicrosoft' ? 'Completa el inicio de sesión en Microsoft...' : 'Entrando...';
        try {
            if (typeof window.launcherAPI?.[method] !== 'function') throw new Error('No se pudo conectar con el motor del launcher.');
            const result = await window.launcherAPI[method](argument);
            if (result && (result.success || result.username)) await setCredentials(result.profile || result);
            else throw new Error(result?.error?.message || result?.error || 'No se pudo iniciar sesión.');
        } catch (error) {
            status.textContent = 'Error: ' + (error?.message || String(error));
        } finally {
            loginBusy = false;
            controls.forEach(control => control.disabled = false);
        }
    }
    async function loginMicrosoft() { return performLogin('loginMicrosoft'); }
    async function loginOffline() {
        const nick = $('#nick-input').value.trim();
        if (nick.length < 3) {
            $('#login-status').textContent = 'El nick debe tener al menos 3 caracteres.';
            $('#nick-input').focus();
            return;
        }
        return performLogin('loginOffline', nick);
    }

    async function setCredentials(profile) {
        communitySession = null;
        state.creds = {
            ...profile,
            name: profile.name || profile.username,
            id: profile.id || profile.uuid,
            access_token: profile.access_token || profile.accessToken,
            skinUrl: profile.skinUrl || profile.skin_url,
            avatarUrl: profile.avatarUrl || profile.avatar_url,
        };

        if (state.skinViewer && state.creds.skinUrl?.startsWith('data:image/')) {
            await safeCall(() => state.skinViewer.loadSkin(state.creds.skinUrl, { model: state.skinModel }));
        }

        const face = await resolveAvatar(state.creds);
        $('#sidebar-avatar').src = face;
        $('#drawer-avatar').src = face;
        $('#drawer-name').textContent = state.creds.name || 'Usuario';
        $('#drawer-type').textContent = state.creds.meta ? 'Offline' : 'Microsoft';

        await loadEvents();
        showScreen('screen-app');
        await startSocialPresence();

        updateLaunchCardIdle();
        navigateTo('instances');
        if (localStorage.getItem('migajasTutorialSeen') !== '1') startTutorial(true);
        void window.MigajasNews?.onLogin().catch(error => console.warn(error.message));
    }

    async function logout() {
        communitySession = null;
        closeDrawer();
        window.launcherCommunity?.reset();
        window.launcherLibrary?.reset();
        if (state.socialHeartbeat) clearInterval(state.socialHeartbeat);
        state.socialHeartbeat = null;
        if (socialIdentity() && socialConfig().url && socialConfig().key) {
            try { await socialRequest('offline'); } catch (error) { console.warn('[social] no se pudo limpiar la presencia:', error); }
        }
        if (state.creds && !state.creds.meta) {
            await safeCall(() => window.launcherAPI.logoutMicrosoft());
        }
        state.creds = null;
        communitySession = null;
        state.selectedInstance = null;
        state.events = [];
        state.allEvents = [];
        state.whitelistAdminUnlocked = false;
        state.whitelistAdminCode = '';
        showScreen('screen-login');
        $('.login-box')?.classList.add('show');
    }

    /* ───────────── AVATAR HELPERS ───────────── */
    async function resolveAvatar(profile) {
        if (!profile) return AVATAR_PLACEHOLDER;
        const avatar = profile.avatarUrl || profile.avatar_url;
        const skin   = profile.skinUrl   || profile.skin_url;

        if (avatar?.startsWith('data:image/')) return avatar;
        if (skin?.startsWith('data:image/')) {
            try { return await cropHead(skin); } catch (_) {}
        }
        return AVATAR_PLACEHOLDER;
    }

    function cropHead(skinDataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const w = img.naturalWidth, h = img.naturalHeight;
                if (w < 64 || h < 32 || w % 64 !== 0 || h % 32 !== 0) {
                    return reject(new Error('Dimensiones inválidas'));
                }
                const scale = w / 64;
                const headSize = 8 * scale;
                const canvas = $('#head-crop-canvas');
                canvas.width = 64; canvas.height = 64;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(img, 8 * scale, 8 * scale, headSize, headSize, 0, 0, 64, 64);
                if (h >= 64 * scale) {
                    ctx.drawImage(img, 40 * scale, 8 * scale, headSize, headSize, 0, 0, 64, 64);
                }
                resolve(canvas.toDataURL('image/png'));
            };
            img.onerror = () => reject(new Error('Skin inválida'));
            img.src = skinDataUrl;
        });
    }

    async function updateProfileFaceFromSkin(skinDataUrl) {
        if (!state.creds || !skinDataUrl?.startsWith('data:image/png;base64,')) return;
        try {
            const face = await cropHead(skinDataUrl);
            state.creds.avatarUrl = face;
            $('#sidebar-avatar').src = face;
            $('#drawer-avatar').src = face;
        } catch (error) {
            console.warn('[skin] No se pudo actualizar la cara del perfil:', error);
        }
    }

    /* ═══════════════════════════════════════════════════════════════════
       EVENTOS / INSTANCIAS
       ═══════════════════════════════════════════════════════════════════ */
    async function loadEvents() {
        const url = "https://gist.githubusercontent.com/Dexi-lov/8f8babdea6a5bccfe2c2d8a4fe4d8849/raw/evento_migajas.json?" + Date.now();
        state.instanceAccessError = '';
        try {
            const response = window.MIGAJAS_SOCIAL_CONFIG?.communityUrl
                ? { ok: true, json: async () => (await socialRequest('catalog')).events }
                : await fetch(url, { cache: 'no-store' });
            if (!response.ok) throw new Error(`No se pudo cargar el catálogo de eventos (HTTP ${response.status}).`);
            const data = await response.json();
            state.allEvents = Array.isArray(data) ? data : (data ? [data] : []);
            const access = await window.launcherAPI.gistGetLauncherWhitelist();
            state.launcherWhitelistEnabled = Boolean(access.enabled);
            if (!access.enabled) {
                state.events = state.allEvents;
            } else {
                const username = String(state.creds?.username || state.creds?.name || '').trim().toLowerCase();
                const uuid = String(state.creds?.uuid || '').replace(/-/g, '').toLowerCase();
                const allowed = Array.isArray(access.allowed) ? access.allowed : [];
                const allowedNames = new Set(allowed.map(value => String(value).trim().toLowerCase()));
                const allowedUuids = new Set(allowed.map(value => String(value).trim().replace(/-/g, '').toLowerCase()));
                state.events = state.allEvents.filter(() => allowedNames.has(username) || allowedUuids.has(uuid));
            }
        } catch (error) {
            state.allEvents = [];
            state.events = [];
            state.instanceAccessError = error?.message || 'No se pudo verificar el acceso a las instancias.';
        }
        if (state.selectedInstance && !state.selectedInstance.archived && !state.events.some(event => event.id === state.selectedInstance.id)) {
            state.selectedInstance = null;
        }
        renderSidebarInstances();
        renderInstancesGrid();
        if (!state.selectedInstance) updateLaunchCardIdle();
        await refreshLocalInstances();
    }

    function downloadedArchivedEvents() {
        return state.localInstances.filter(instance => instance.installed && (instance.manifest?.archived
            || !state.allEvents.some(event => String(event.id) === String(instance.instanceId)))
            && !state.events.some(event => String(event.id) === String(instance.instanceId)))
            .map(instance => ({ ...instance.manifest, id: instance.instanceId,
                nombre_evento: instance.name, archived: true, managed_pack: true }));
    }

    function renderSidebarInstances() {
        const container = $('#sidebar-instances');
        container.innerHTML = '';

        const archivedEvents = downloadedArchivedEvents();
        if (state.selectedInstance?.archived && !state.events.some(event => event.id === state.selectedInstance.id)
            && !archivedEvents.some(event => event.id === state.selectedInstance.id)) archivedEvents.push(state.selectedInstance);
        const sidebarEvents = [...state.events, ...archivedEvents];
        sidebarEvents.forEach((ev, i) => {
            if (archivedEvents.length && i === state.events.length) {
                const divider = document.createElement('div');
                divider.className = 'sidebar-divider sidebar-archive-divider';
                divider.setAttribute('role', 'separator');
                divider.setAttribute('aria-label', 'Eventos anteriores descargados');
                container.appendChild(divider);
            }
            const btn = document.createElement('button');
            btn.className = 'sidebar-btn instance-btn';
            btn.dataset.index = i;
            btn.dataset.id = ev.id;
            btn.classList.toggle('is-selected', String(state.selectedInstance?.id) === String(ev.id));
            btn.title = ev.nombre_evento || 'Instancia';

            const imageSources = [ev.icono, ev.logo, ev.imagen, ev.imagen_evento, ev.imagen_fondo, ev.banner, 'logo.png']
                .filter(source => typeof source === 'string' && source.trim())
                .map(source => source.trim());
            if (imageSources.length) {
                btn.classList.add('has-event-image');
                const image = document.createElement('img');
                image.className = 'instance-image';
                image.alt = '';
                image.setAttribute('aria-hidden', 'true');
                let sourceIndex = 0;
                image.onerror = () => {
                    sourceIndex += 1;
                    if (sourceIndex < imageSources.length) image.src = imageSources[sourceIndex];
                    else image.remove();
                };
                image.src = imageSources[sourceIndex];
                btn.appendChild(image);
            }

            const tip = document.createElement('span');
            tip.className = 'tooltip';
            tip.textContent = ev.nombre_evento || 'Instancia';
            btn.appendChild(tip);

            btn.addEventListener('click', () => {
                selectInstance(ev.id, ev.archived ? ev : undefined);
                navigateTo('hero');
                if (state.tutorialStep === 'catalog') showTutorialStep('play');
            });
            container.appendChild(btn);
        });
    }

    function renderInstancesGrid() {
        const grid = $('#instances-grid');
        if (!grid) return;
        grid.innerHTML = '';

        if (!state.events.length) {
            grid.innerHTML = `
                <div class="instances-empty">
                    <i class="fas ${state.instanceAccessError ? 'fa-triangle-exclamation' : 'fa-folder-open'}"></i>
                    <p>${escapeHtml(state.instanceAccessError || (state.launcherWhitelistEnabled ? 'Tu cuenta no está autorizada para ver las instancias disponibles.' : 'No hay instancias disponibles'))}</p>
                </div>`;
            return;
        }

        state.events.forEach(ev => {
            const card = document.createElement('article');
            card.className = 'instance-card';
            card.dataset.id = ev.id;
            card.innerHTML = `
                <div class="instance-card-bg"></div>
                ${ev.official ? '<span class="instance-card-badge">Oficial</span>' : ev.destacado ? '<span class="instance-card-badge">Nuevo</span>' : ''}
                <div class="instance-card-info">
                    <h3 class="instance-card-title">${escapeHtml(ev.nombre_evento || 'Instancia')}</h3>
                    <div class="instance-card-sub">${escapeHtml(ev.version || ev.tipo || 'Minecraft')}</div>
                </div>
            `;
            const background = card.querySelector('.instance-card-bg');
            if (ev.imagen_fondo) background.style.backgroundImage = `url(${JSON.stringify(String(ev.imagen_fondo))})`;
            else background.style.background = 'linear-gradient(135deg,#1a1b20,#0d0e11)';
            card.addEventListener('click', () => {
                selectInstance(ev.id);
                navigateTo('hero');
                if (state.tutorialStep === 'catalog') showTutorialStep('play');
            });
            grid.appendChild(card);
        });

        const q = ($('#instances-search')?.value || '').trim();
        if (q) applyInstancesFilter(q);
    }

    function selectInstance(id, archivedEvent) {
        const ev = archivedEvent || state.events.find(e => e.id === id) || downloadedArchivedEvents().find(e => e.id === id);
        if (!ev) return;
        state.selectedInstance = ev;

        $$('.sidebar-btn.instance-btn').forEach(b => {
            b.classList.toggle('is-selected', b.dataset.id === String(id));
        });

        $$('.instance-card').forEach(c => c.classList.toggle('selected', c.dataset.id === id));

        const heroBg = $('#hero-bg');
        heroBg.style.backgroundImage = ev.imagen_fondo ? `url("${ev.imagen_fondo}")` : 'none';

        const logo = $('#hero-logo');
        const title = $('#hero-title');
        const logoUrl = ev.logo || ev.icono;

        if (logoUrl) {
            logo.src = logoUrl;
            logo.style.display = 'block';
            title.style.display = 'none';
        } else {
            logo.style.display = 'none';
            title.style.display = 'none';
            title.textContent = '';
        }

        const sponsorEl = $('#hero-sponsor-text');
        if (sponsorEl) {
            let sponsorText = 'MIGAJAS STUDIO';
            const sp = ev.sponsors;
            if (Array.isArray(sp) && sp.length) {
                sponsorText = sp.filter(Boolean).join(' • ');
            } else if (typeof sp === 'string' && sp.trim()) {
                sponsorText = sp.trim();
            }
            sponsorEl.textContent = sponsorText;
        }

        updateLaunchCardIdle();
        if (state.activeGameInstanceId === ev.id) showGameProcessStatus(ev.id, 'RUNNING');
        updateServerStatus(ev.servidor_ip);
    }

    function initInstanceContextMenu() {
        const menu = $('#instance-context-menu');
        const title = $('#instance-context-title');
        const deleteButton = $('#instance-context-delete');
        for (const selector of ['#sidebar-instances', '#instances-grid']) {
            $(selector)?.addEventListener('contextmenu', (event) => {
                const target = event.target.closest('.instance-btn, .instance-card');
                if (!target) return;
                const instance = [...state.events, ...downloadedArchivedEvents()].find(item => item.id === target.dataset.id);
                if (!instance) return;
                event.preventDefault();
                state.contextInstanceId = instance.id;
                title.textContent = instance.nombre_evento || instance.id;
                deleteButton.disabled = !state.localInstances.some(item => item.instanceId === instance.id);
                const margin = 8;
                menu.hidden = false;
                const rect = menu.getBoundingClientRect();
                menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - rect.width - margin))}px`;
                menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - rect.height - margin))}px`;
            });
        }
        document.addEventListener('pointerdown', (event) => {
            if (!menu.hidden && !menu.contains(event.target)) hideInstanceContextMenu();
        });
        window.addEventListener('resize', hideInstanceContextMenu);
        $('#instance-context-config')?.addEventListener('click', async () => {
            const id = state.contextInstanceId;
            hideInstanceContextMenu();
            if (!id) return;
            selectInstance(id);
            await openInstanceSettings(id);
        });
        deleteButton?.addEventListener('click', deleteContextInstance);
    }

    function hideInstanceContextMenu() {
        const menu = $('#instance-context-menu');
        if (menu) menu.hidden = true;
    }

    async function deleteContextInstance() {
        const id = state.contextInstanceId;
        const instance = [...state.events, ...downloadedArchivedEvents()].find(item => item.id === id);
        hideInstanceContextMenu();
        if (!id || !state.localInstances.some(item => item.instanceId === id)) return;
        const name = instance?.nombre_evento || id;
        if (!confirm(`¿Seguro que deseas eliminar “${name}” y todos sus datos locales? Esta acción no se puede deshacer.`)) return;
        try {
            await window.launcherAPI.deletePreviousInstance(id);
            const wasSelected = state.selectedInstance?.id === id;
            if (wasSelected) state.selectedInstance = null;
            await loadEvents();
            if (wasSelected && state.events.length) {
                const fallback = state.events.find(event => event.id !== id) || state.events[0];
                selectInstance(fallback.id);
                navigateTo('hero');
            }
            flashLaunchStatus('Instancia eliminada', 'success');
        } catch (error) {
            alert(`No se pudo eliminar la instancia: ${error?.message || error}`);
        }
    }

    /* ═══════════════════════════════════════════════════════════════════
       BÚSQUEDA EN VIVO
       ═══════════════════════════════════════════════════════════════════ */
    function initInstancesSearch() {
        const input = $('#instances-search');
        if (!input) return;
        input.addEventListener('input', (e) => {
            applyInstancesFilter(e.target.value);
        });
    }

    function applyInstancesFilter(rawQuery) {
        const query = String(rawQuery || '').toLowerCase().trim();
        const cards = $$('.instance-card');

        cards.forEach(card => {
            const title = (card.querySelector('.instance-card-title')?.textContent || '').toLowerCase();
            const sub = (card.querySelector('.instance-card-sub')?.textContent || '').toLowerCase();
            const match = !query || title.includes(query) || sub.includes(query);
            card.style.display = match ? '' : 'none';
        });

        const grid = $('#instances-grid');
        if (!grid) return;
        let emptyMsg = grid.querySelector('.no-results-msg');
        const visible = cards.filter(c => c.style.display !== 'none');

        if (query && cards.length > 0 && visible.length === 0) {
            if (!emptyMsg) {
                emptyMsg = document.createElement('div');
                emptyMsg.className = 'instances-empty no-results-msg';
                emptyMsg.innerHTML = '<i class="fas fa-search"></i><p>No se encontraron resultados</p>';
                grid.appendChild(emptyMsg);
            }
        } else if (emptyMsg) {
            emptyMsg.remove();
        }
    }

    /* ═══════════════════════════════════════════════════════════════════
       NAVEGACIÓN
       ═══════════════════════════════════════════════════════════════════ */
    function navigateTo(view) {
        state.currentView = view;
        window.launcherLibrary?.onNavigate(view);
        $$('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('view-' + view)?.classList.add('active');

        $$('.sidebar-btn[data-nav]').forEach(b => {
            b.classList.toggle('active', b.dataset.nav === view);
        });
    }

    function initSidebarHandlers() {
        $$('.sidebar-btn[data-nav]').forEach(btn => {
            btn.addEventListener('click', () => navigateTo(btn.dataset.nav));
        });

        $('#hero-back-btn')?.addEventListener('click', () => navigateTo('instances'));

        $('#sidebar-add')?.addEventListener('click', () => {
            window.launcherCommunity?.openAdmin().catch(error => flashLaunchStatus(error.message, 'error'));
        });



        $('#sidebar-avatar-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleDrawer();
        });
        $('#sidebar-friends')?.addEventListener('click', openFriendsModal);
        $('#social-refresh')?.addEventListener('click', () => refreshSocialLists(true));
        $('#social-tab-friends')?.addEventListener('click', () => setSocialTab('friends'));
        $('#social-tab-requests')?.addEventListener('click', () => setSocialTab('requests'));
        $('#social-add-toggle')?.addEventListener('click', () => {
            const form = $('#social-add-form'); form.hidden = !form.hidden;
            if (!form.hidden) $('#social-add-username').focus();
        });
        $('#social-search-toggle')?.addEventListener('click', () => {
            const form = $('#social-search-form'); form.hidden = !form.hidden;
            if (!form.hidden) $('#social-search-input').focus();
            else { $('#social-search-input').value = ''; renderSocialFriends(state.socialFriends); }
        });
        $('#social-search-input')?.addEventListener('input', () => renderSocialFriends(state.socialFriends));
        $('#social-add-form')?.addEventListener('submit', event => { event.preventDefault(); sendFriendRequest(); });
        $('#social-friends-list')?.addEventListener('click', handleFriendAction);
        $('#social-requests-list')?.addEventListener('click', handleFriendAction);
        $('#social-notifications')?.addEventListener('click', handleSocialNotificationAction);
    }

    function socialConfig() {
        const config = window.MIGAJAS_SOCIAL_CONFIG || {};
        return { url: String(config.url || '').trim().replace(/\/$/, ''), key: String(config.publishableKey || '').trim(), communityUrl: String(config.communityUrl || '').trim().replace(/\/$/, '') };
    }

    function socialIdentity() {
        const profile = state.creds;
        if (!profile) return null;
        const username = String(profile.username || profile.name || '').trim();
        const accountType = String(profile.accountType || '').toLowerCase();
        if (profile.meta || accountType === 'offline') {
            return /^[\p{L}\p{N}_]{3,16}$/u.test(username) ? { accountType: 'offline', username } : null;
        }
        return profile.access_token ? { accountType: 'microsoft', username } : null;
    }

    let socialSessionRefresh = null;
    let communitySession = null;
    async function refreshSocialSession() {
        if (!socialSessionRefresh) {
            const requestedUuid = state.creds?.uuid;
            socialSessionRefresh = (async () => {
                const restored = await window.launcherAPI.loginMicrosoftSilent(requestedUuid);
                const profile = restored?.profile;
                const normalize = value => String(value || '').replace(/-/g, '').toLowerCase();
                if (!restored?.success || !profile || normalize(profile.uuid) !== normalize(requestedUuid)) {
                    throw new Error(restored?.error?.message || 'No se pudo renovar la sesión de Microsoft.');
                }
                if (normalize(state.creds?.uuid) !== normalize(requestedUuid)) throw new Error('La cuenta cambió durante la consulta. Vuelve a intentarlo.');
                const token = profile.access_token || profile.accessToken;
                if (!token) throw new Error('Minecraft no devolvió una sesión válida.');
                state.creds = { ...state.creds, ...profile, access_token: token };
                communitySession = null;
            })().finally(() => { socialSessionRefresh = null; });
        }
        return socialSessionRefresh;
    }
    async function socialRequest(action, data = {}) {
        const { url, key, communityUrl } = socialConfig();
        if (!url || !key) throw new Error('Los amigos todavía no están activados en esta versión del launcher.');
        if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) throw new Error('La URL debe ser la URL HTTPS del proyecto Supabase.');
        let renewed = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            const identity = socialIdentity();
            if (!identity) throw new Error('Inicia sesión para usar amigos y consultar la presencia.');
            const session = identity.accountType === 'microsoft' ? communitySession : null;
            const token = identity.accountType === 'microsoft' ? state.creds.access_token : undefined;
            const response = await fetch(communityUrl || `${url}/functions/v1/migajas-social`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
                body: JSON.stringify({ action, ...data, clientVersion: window.MIGAJAS_SOCIAL_CONFIG?.clientVersion, accountType: identity.accountType, identityUsername: identity.username, identityUuid: state.creds.uuid, minecraftAccessToken: token, communitySession: session }),
                signal: AbortSignal.timeout(35000),
            });
            const result = await response.json().catch(() => ({}));
            if (response.status === 401 && session) { communitySession = null; continue; }
            if (response.status === 401 && identity.accountType === 'microsoft' && !renewed) {
                renewed = true;
                await refreshSocialSession();
                continue;
            }
            if (!response.ok) throw new Error(result.error || `El servicio social respondió HTTP ${response.status}.`);
            if (result.communitySession) communitySession = result.communitySession;
            return result;
        }
        throw new Error('No se pudo renovar la sesión de comunidad. Vuelve a intentarlo.');
    }

    async function openFriendsModal() {
        $('#social-friends-list').replaceChildren();
        $('#social-whitelist-list').replaceChildren();
        $('#social-add-form').hidden = true;
        $('#social-search-form').hidden = true;
        $('#social-search-input').value = '';
        setSocialTab('friends');
        const username = String(state.creds?.username || state.creds?.name || '?');
        setSocialAvatar($('#social-profile-initial'), state.creds?.avatarUrl || state.creds?.avatar_url, username);
        $('#social-whitelist-event').textContent = state.selectedInstance?.nombre_evento || 'Selecciona un evento para ver su lista.';
        openModal('friends-modal');
        if (state.socialRefreshTimer) clearInterval(state.socialRefreshTimer);
        if (!socialIdentity()) {
            $('#social-status').textContent = 'Inicia sesión para consultar amigos y presencia.';
            return;
        }
        if (!socialConfig().url || !socialConfig().key) {
            $('#social-status').textContent = 'El sistema de amigos todavía no está conectado. Pronto estará disponible en una actualización del launcher.';
            return;
        }
        await refreshSocialLists();
        state.socialRefreshTimer = setInterval(() => {
            if ($('#friends-modal')?.classList.contains('open')) refreshSocialLists();
        }, 10000);
    }

    async function startSocialPresence() {
        if (state.socialHeartbeat) clearInterval(state.socialHeartbeat);
        if (!socialConfig().url || !socialConfig().key || !socialIdentity()) return;
        state.socialLastActivityAt = Date.now();
        initSocialActivityTracking();
        await sendSocialHeartbeat();
        state.socialHeartbeat = setInterval(sendSocialHeartbeat, 15000);
    }

    function initSocialActivityTracking() {
        if (state.socialActivityTracking) return;
        const markActivity = () => {
            const now = Date.now();
            const wasAfk = now - state.socialLastActivityAt >= 5 * 60 * 1000;
            if (now - state.socialLastActivityAt >= 1000) state.socialLastActivityAt = now;
            if (wasAfk && state.socialHeartbeat && !state.activeGameInstanceId) sendSocialHeartbeat();
        };
        for (const eventName of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) {
            document.addEventListener(eventName, markActivity, { passive: true });
        }
        window.addEventListener('focus', markActivity);
        state.socialActivityTracking = true;
    }

    function getSocialPresencePayload() {
        const communityPresence = window.launcherCommunity?.presence();
        if (communityPresence) return communityPresence;
        const playing = Boolean(state.activeGameInstanceId);
        const idleFor = Date.now() - state.socialLastActivityAt;
        return {
            mode: playing ? 'playing' : idleFor >= 5 * 60 * 1000 ? 'afk' : 'active',
            instanceId: playing ? state.activeGameInstanceId : null,
        };
    }

    async function sendSocialHeartbeat() {
        try {
            const result = await socialRequest('heartbeat', getSocialPresencePayload());
            handleSocialPendingRequests(result.pendingRequests || []);
            window.launcherCommunity?.receiveHeartbeat(result);
            if (state.instanceAccessError) await loadEvents();
        } catch (error) {
            if ($('#social-status') && $('#friends-modal')?.classList.contains('open')) $('#social-status').textContent = error?.message || String(error);
        }
    }

    async function refreshSocialLists(manual = false) {
        if (state.socialRefreshInFlight) return;
        state.socialRefreshInFlight = true;
        const status = $('#social-status');
        const refreshButton = $('#social-refresh');
        if (refreshButton) { refreshButton.disabled = true; refreshButton.classList.add('is-refreshing'); }
        status.textContent = manual ? 'Actualizando amigos y actividad…' : 'Consultando el servicio…';
        try {
            const result = await socialRequest('friends');
            state.socialFriends = result.friends || [];
            state.socialRequestCount = state.socialFriends.filter(friend => friend.direction === 'received').length;
            updateSocialRequestBadges();
            renderSocialFriends(state.socialFriends);
            renderSocialRequests(state.socialFriends);
            await refreshWhitelistPresence();
            const updatedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            status.textContent = `Lista actualizada · ${updatedAt}`;
        } catch (error) {
            status.textContent = error?.message || String(error);
            renderSocialEmpty($('#social-friends-list'), 'No se pudo cargar la lista de amigos.');
        } finally {
            state.socialRefreshInFlight = false;
            if (refreshButton) { refreshButton.disabled = false; refreshButton.classList.remove('is-refreshing'); }
        }
    }

    function renderSocialEmpty(root, message) {
        root.replaceChildren(); const node = document.createElement('p'); node.className = 'settings-hint'; node.textContent = message; root.appendChild(node);
    }

    function renderSocialFriends(friends) {
        const root = $('#social-friends-list'); root.replaceChildren();
        const query = ($('#social-search-input')?.value || '').trim().toLocaleLowerCase();
        const visible = friends.filter(friend => friend.direction === 'friend' && String(friend.username).toLocaleLowerCase().includes(query));
        if (!visible.length) { renderSocialEmpty(root, query ? 'No hay amigos con ese nombre.' : 'Todavía no tienes amigos. Pulsa el icono de persona para añadir uno.'); return; }
        for (const friend of visible) root.appendChild(createSocialFriendRow(friend, 'friend'));
    }

    function renderSocialRequests(friends) {
        const root = $('#social-requests-list'); root.replaceChildren();
        const requests = friends.filter(friend => friend.direction === 'received' || friend.direction === 'sent');
        if (!requests.length) { renderSocialEmpty(root, 'No tienes solicitudes pendientes.'); return; }
        for (const request of requests) root.appendChild(createSocialFriendRow(request, request.direction));
    }

    function createSocialFriendRow(person, kind) {
        const row = document.createElement('div'); row.className = 'social-friend-row';
        const avatar = document.createElement('span');
        avatar.className = `social-friend-avatar ${person.online ? 'online' : 'offline'}`;
        const username = String(person.username || '?');
        avatar.textContent = username.slice(0, 1).toLocaleUpperCase();
        const uuid = String(person.uuid || '').replace(/-/g, '');
        if (/^[0-9a-f]{32}$/i.test(uuid)) {
            const image = document.createElement('img');
            image.className = 'social-avatar-image'; image.alt = ''; image.loading = 'lazy';
            image.src = `https://mc-heads.net/avatar/${uuid}/64`;
            image.onerror = () => image.remove();
            avatar.appendChild(image);
        }
        const copy = document.createElement('span'); copy.className = 'social-friend-copy';
        const name = document.createElement('span'); name.className = 'social-friend-name'; name.textContent = person.username || 'Jugador';
        const activity = document.createElement('span'); activity.className = 'social-friend-activity';
        activity.textContent = kind === 'received' ? 'Te envió una solicitud'
            : kind === 'sent' ? 'Solicitud enviada'
                : !person.online ? 'Desconectado'
                    : person.mode === 'playing' ? `Jugando — ${eventName(person.instanceId)}`
                        : person.mode === 'preparing' ? `Descargando — ${eventName(person.instanceId)}`
                        : person.mode === 'ready' ? `Listo para — ${eventName(person.instanceId)}`
                        : person.mode === 'afk' ? 'Ausente (AFK)' : 'En línea';
        if (window.launcherCommunity?.enabled()) {
            name.setAttribute('role', 'button'); name.tabIndex = 0; name.style.cursor = 'pointer';
            const openProfile = () => window.launcherCommunity.openProfile(person.uuid);
            name.addEventListener('click', openProfile);
            name.addEventListener('keydown', event => { if (event.key === 'Enter') openProfile(); });
            const labels = {owner:'Fundador',admin:'Administración',organizer:'Organizador',moderator:'Moderación'};
            for (const tag of person.tags || []) { const badge = document.createElement('span'); badge.className='community-tag'; badge.textContent=labels[tag.role] || tag.role; copy.append(badge); }
        }
        copy.append(name, activity);
        const playingEvent = state.allEvents?.find(event => event.id === person.instanceId);
        if (person.online && person.instanceId && playingEvent?.imagen_fondo) { const image = document.createElement('img'); image.src = playingEvent.imagen_fondo; image.alt = playingEvent.nombre_evento || 'Evento'; image.className = 'community-event-image'; image.style.height = '42px'; image.onerror = () => image.remove(); copy.append(image); }
        row.append(avatar, copy);
        if (kind === 'friend' && window.launcherCommunity?.enabled()) row.append(socialActionButton('Invitar', 'invite', person.uuid));
        if (kind === 'received') {
            row.append(socialActionButton('Aceptar', 'accept', person.uuid), socialActionButton('×', 'remove', person.uuid));
        } else if (kind === 'sent') {
            row.append(socialActionButton('Cancelar', 'remove', person.uuid));
        } else {
            row.append(socialActionButton('×', 'remove', person.uuid));
        }
        return row;
    }

    function setSocialAvatar(container, source, username) {
        if (!container) return;
        const fallback = $('#social-profile-fallback');
        if (fallback) fallback.textContent = String(username || '?').slice(0, 1).toLocaleUpperCase();
        container.querySelector('.social-avatar-image')?.remove();
        if (!source || typeof source !== 'string') return;
        const image = document.createElement('img');
        image.className = 'social-avatar-image'; image.alt = '';
        image.src = source;
        image.onerror = () => image.remove();
        container.appendChild(image);
    }

    function setSocialTab(tab) {
        const friends = tab === 'friends';
        $('#social-tab-friends')?.classList.toggle('active', friends);
        $('#social-tab-friends')?.setAttribute('aria-selected', String(friends));
        $('#social-tab-requests')?.classList.toggle('active', !friends);
        $('#social-tab-requests')?.setAttribute('aria-selected', String(!friends));
        $('#social-friends-view').hidden = !friends;
        $('#social-requests-view').hidden = friends;
    }

    function updateSocialRequestBadges() {
        const count = state.socialRequestCount || 0;
        for (const badge of [$('#sidebar-friend-count'), $('#social-request-count')]) {
            if (!badge) continue;
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.hidden = count === 0;
        }
    }

    function seenSocialRequests() {
        try { return new Set(JSON.parse(localStorage.getItem('migajasSeenFriendRequests') || '[]')); }
        catch (_) { return new Set(); }
    }

    function handleSocialPendingRequests(requests) {
        const pending = Array.isArray(requests) ? requests : [];
        state.socialRequestCount = pending.length;
        updateSocialRequestBadges();
        const seen = seenSocialRequests();
        for (const request of pending) {
            const id = `${String(request.uuid || '')}:${String(request.createdAt || '')}`;
            if (!id || seen.has(id)) continue;
            seen.add(id);
            showFriendRequestNotification(request);
        }
        localStorage.setItem('migajasSeenFriendRequests', JSON.stringify([...seen].slice(-100)));
    }

    function showFriendRequestNotification(request) {
        const root = $('#social-notifications');
        const toast = document.createElement('article'); toast.className = 'social-notification'; toast.dataset.uuid = request.uuid;
        const content = document.createElement('div'); content.className = 'social-notification-copy';
        const title = document.createElement('strong'); title.textContent = 'Nueva solicitud de amistad';
        const description = document.createElement('span'); description.textContent = `${request.username || 'Un jugador'} quiere agregarte.`;
        const actions = document.createElement('div'); actions.className = 'social-notification-actions';
        const accept = document.createElement('button'); accept.className = 'primary'; accept.type = 'button'; accept.dataset.notificationAction = 'accept'; accept.textContent = 'Aceptar';
        const view = document.createElement('button'); view.type = 'button'; view.dataset.notificationAction = 'view'; view.textContent = 'Ver solicitudes';
        actions.append(accept, view); content.append(title, description, actions);
        const dismiss = document.createElement('button'); dismiss.className = 'social-notification-close'; dismiss.type = 'button'; dismiss.dataset.notificationAction = 'dismiss'; dismiss.setAttribute('aria-label', 'Cerrar notificación'); dismiss.textContent = '×';
        toast.append(content, dismiss); root.appendChild(toast);
        while (root.children.length > 3) root.firstElementChild.remove();
    }

    async function handleSocialNotificationAction(event) {
        const button = event.target.closest('button[data-notification-action]'); if (!button) return;
        const toast = button.closest('.social-notification');
        const action = button.dataset.notificationAction;
        if (action === 'view') {
            toast?.remove();
            await openFriendsModal();
            setSocialTab('requests');
            return;
        }
        if (action === 'dismiss') { toast?.remove(); return; }
        button.disabled = true;
        try {
            await socialRequest('friend_request', { uuid: toast.dataset.uuid, accept: true });
            toast.remove();
            flashLaunchStatus('Solicitud de amistad aceptada', 'success');
            if ($('#friends-modal')?.classList.contains('open')) refreshSocialLists();
        } catch (error) {
            button.disabled = false;
            const description = toast.querySelector('.social-notification-copy span');
            description.textContent = error?.message || String(error);
        }
    }

    function socialActionButton(text, action, uuid) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'social-friend-action'; button.textContent = text;
        button.setAttribute('aria-label', text === '×' ? 'Eliminar amistad o solicitud' : text);
        button.dataset.socialAction = action; button.dataset.uuid = uuid; return button;
    }

    async function handleFriendAction(event) {
        const button = event.target.closest('button[data-social-action]'); if (!button) return;
        button.disabled = true;
        try {
            if (button.dataset.socialAction === 'invite') { await window.launcherCommunity.invite(button.dataset.uuid); $('#social-status').textContent = 'Invitación enviada.'; button.disabled=false; return; }
            if (button.dataset.socialAction === 'accept') await socialRequest('friend_request', { uuid: button.dataset.uuid, accept: true });
            else await socialRequest('friend_remove', { uuid: button.dataset.uuid });
            document.querySelectorAll('.social-notification').forEach(toast => {
                if (toast.dataset.uuid === button.dataset.uuid) toast.remove();
            });
            await refreshSocialLists();
        } catch (error) { $('#social-status').textContent = error?.message || String(error); button.disabled = false; }
    }

    async function sendFriendRequest() {
        const username = $('#social-add-username').value.trim();
        try {
            await socialRequest('friend_request', { username });
            $('#social-add-username').value = ''; $('#social-status').textContent = 'Solicitud enviada o amistad aceptada.';
            await refreshSocialLists();
        } catch (error) { $('#social-status').textContent = error?.message || String(error); }
    }

    function eventName(instanceId) {
        const match = state.allEvents?.find(item => String(item.id) === String(instanceId)) || (state.selectedInstance?.id === instanceId ? state.selectedInstance : null);
        return match?.nombre_evento || instanceId || 'evento';
    }

    async function refreshWhitelistPresence() {
        const root = $('#social-whitelist-list'); root.replaceChildren();
        const instance = state.selectedInstance;
        if (!instance?.whitelist?.enabled || !Array.isArray(instance.whitelist.allowed)) {
            $('#social-whitelist-event').textContent = 'Este evento no tiene whitelist activa.';
            renderSocialEmpty(root, 'Todos pueden ver el evento.'); return;
        }
        $('#social-whitelist-event').textContent = instance.nombre_evento || instance.id;
        const result = await socialRequest('whitelist_presence', { instanceId: instance.id });
        const people = result.people || [];
        if (!people.length) { renderSocialEmpty(root, 'Aún no hay personas de esta whitelist registradas en el launcher.'); return; }
        for (const person of people) {
            root.appendChild(createSocialFriendRow(person, 'friend'));
        }
    }

    /* ═══════════════════════════════════════════════════════════════════
       PROFILE DRAWER
       ═══════════════════════════════════════════════════════════════════ */
    function toggleDrawer() {
        const drawer = $('#profile-drawer');
        const backdrop = $('#drawer-backdrop');
        const open = drawer.classList.toggle('open');
        backdrop.classList.toggle('open', open);
    }

    function closeDrawer() {
        $('#profile-drawer')?.classList.remove('open');
        $('#drawer-backdrop')?.classList.remove('open');
    }

    function initDrawerHandlers() {
        $('#drawer-backdrop')?.addEventListener('click', closeDrawer);
        $$('[data-legal-page]').forEach(link => link.addEventListener('click', event => {
            event.preventDefault();
            openLegalPage(link.dataset.legalPage);
        }));
        $('#discord-invite')?.addEventListener('click', event => {
            event.preventDefault();
            openDiscordInvite();
        });

        $$('.drawer-item').forEach(item => {
            item.addEventListener('click', () => {
                const action = item.dataset.action;
                closeDrawer();
                switch (action) {
                    case 'skin':     openSkinModal(); break;
                    case 'settings': openSettingsModal(); break;
                    case 'tutorial': startTutorial(false); break;
                    case 'help':     openDiscordInvite(); break;
                    case 'logout':   logout(); break;
                }
            });
        });
    }

    async function openDiscordInvite() {
        try {
            await window.launcherAPI.openDiscordInvite();
        } catch (error) {
            console.error('[discord] no se pudo abrir el enlace:', error);
            flashLaunchStatus('No se pudo abrir Discord. Inténtalo de nuevo.', 'error');
        }
    }

    const LEGAL_PAGES = {
        terms: {
            title: 'Términos de uso',
            sections: [
                { title: 'Uso del launcher', text: 'Migajas Launcher permite iniciar y administrar instalaciones y eventos de Minecraft publicados por Migajas Studio. Al usarlo, aceptas utilizarlo de forma responsable y respetar las reglas de cada servidor y evento.' },
                { title: 'Cuentas y contenido', text: 'Debes usar una cuenta que tengas derecho a utilizar y proteger tus credenciales. Solo sube skins, mods y otros archivos que tengas permiso para usar. El acceso a un evento puede depender de una whitelist y de las reglas de sus organizadores.' },
                { title: 'Descargas e instalaciones', text: 'El launcher puede descargar Minecraft, loaders, mods y otros archivos desde los proveedores indicados por cada evento. Estos archivos ocupan espacio y pueden modificar las carpetas locales del juego. Revisa los requisitos del evento y conserva copias de seguridad de los archivos que quieras mantener.' },
                { title: 'Disponibilidad y cambios', text: 'Los eventos, descargas, funciones y servicios en línea pueden cambiar, pausarse o dejar de estar disponibles. El launcher se ofrece tal como está; no se garantiza que cada evento funcione en todos los equipos o configuraciones.' },
                { title: 'Marcas', text: 'Minecraft y las marcas relacionadas pertenecen a sus respectivos titulares. Migajas Launcher es un proyecto de Migajas Studio y no está afiliado, aprobado ni respaldado por Mojang o Microsoft.' },
                { title: 'Ayuda', text: 'Para preguntas, reportes o comentarios puedes contactar al equipo en el Discord de Migajas desde el enlace del perfil.' },
            ],
        },
        privacy: {
            title: 'Aviso de privacidad',
            sections: [
                { title: 'Datos que usa el launcher', text: 'El launcher utiliza el UUID y el nombre de tu perfil de Minecraft para iniciar el juego, aplicar la whitelist y mostrar tu perfil. Las preferencias, los ajustes del juego, las instancias y sus archivos se guardan localmente en tu equipo.' },
                { title: 'Inicio de sesión', text: 'La autenticación Microsoft se realiza con los servicios de Microsoft y Minecraft. Los tokens necesarios para mantener esa sesión se gestionan localmente mediante el almacén seguro de credenciales del sistema operativo. Al usar Amigos con Microsoft, el token se envía a una función de Supabase para verificar el perfil y no se guarda en las tablas sociales. Las cuentas offline envían su username sin token y no se verifican.' },
                { title: 'Amigos y presencia', text: 'Si utilizas Amigos, el servicio de comunidad con base de datos Cloudflare D1 recibe tu identificador social, username, solicitudes y relaciones de amistad, y tu estado de presencia (activo, AFK o jugando un evento) con la hora de actualización. Tus amigos y las personas autorizadas en la whitelist del evento pueden ver tu presencia. Los nombres de cuentas offline no se verifican y pueden ser suplantados. Al cerrar sesión se elimina el estado de presencia; si el launcher deja de enviar actualizaciones, aparecerás desconectado después de aproximadamente un minuto.' },
                { title: 'Perfiles y administración', text: 'La comunidad guarda tu presentación, preferencias de privacidad, comentarios, invitaciones, bloqueos, etiquetas y participaciones oficiales confirmadas. Los comentarios se muestran en los perfiles y puedes eliminar los tuyos o los de tu perfil. Las acciones administrativas generan un registro de auditoría. Supabase Auth gestiona las credenciales y el segundo factor administrativos; los ZIP subidos se almacenan en un bucket privado de Supabase Storage. Cloudflare aloja la API y la base de datos de comunidad.' },
                { title: 'Servicios externos', text: 'Para funcionar, el launcher se comunica con Microsoft/Minecraft, Supabase, GitHub y los sitios de descarga que indiquen los eventos. Cada proveedor procesa las solicitudes que recibe según sus propias condiciones y avisos de privacidad.' },
                { title: 'Control de tus datos', text: 'Puedes eliminar amistades desde el panel social y borrar instancias y sus archivos locales desde el launcher. Los datos de perfil y relaciones sociales pueden permanecer en el servicio hasta que se eliminen. Para consultas sobre privacidad, contacta al equipo mediante el Discord de Migajas.' },
                { title: 'Cambios a este aviso', text: 'Este texto puede actualizarse cuando cambien las funciones o los servicios utilizados por el launcher. La versión vigente se mostrará en esta sección.' },
            ],
        },
    };

    function openLegalPage(page) {
        const content = LEGAL_PAGES[page];
        if (!content) return;
        $('#legal-title').textContent = content.title;
        const root = $('#legal-content'); root.replaceChildren();
        for (const section of content.sections) {
            const block = document.createElement('section');
            const heading = document.createElement('h3'); heading.textContent = section.title;
            const paragraph = document.createElement('p'); paragraph.textContent = section.text;
            block.append(heading, paragraph); root.appendChild(block);
        }
        openModal('legal-modal');
    }

    /* ═══════════════════════════════════════════════════════════════════
       MODAL HELPERS
       ═══════════════════════════════════════════════════════════════════ */
    function openModal(id) { document.getElementById(id)?.classList.add('open'); }

    let tutorialHistory = [];
    let tutorialTarget = null;
    let tutorialBusy = false;
    let tutorialReturnFocus = null;
    const tutorialOrder = ['welcome', 'catalog', 'play', 'skin', 'ram', 'game-settings', 'delete', 'friends', 'discord'];
    let tutorialPositionFrame = null;
    function scheduleTutorialPosition() {
        if (tutorialPositionFrame !== null) return;
        tutorialPositionFrame = requestAnimationFrame(() => {
            tutorialPositionFrame = null;
            positionTutorial();
        });
    }
    function positionTutorial() {
        if (!state.tutorialStep || $('#tutorial-guide').classList.contains('is-minimized')) return;
        const ring = $('#tutorial-spotlight');
        const card = $('.tutorial-card');
        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = document.documentElement.clientHeight;
        const margin = 16;
        const topMargin = 44;
        let rect = $('#assistant-panel').hidden ? tutorialTarget?.getBoundingClientRect() : null;
        if (rect && (!tutorialTarget.getClientRects().length || !rect.width || !rect.height)) rect = null;
        if (rect) {
            let left = Math.max(4, rect.left - 6), top = Math.max(36, rect.top - 6);
            let right = Math.min(viewportWidth - 4, rect.right + 6), bottom = Math.min(viewportHeight - 4, rect.bottom + 6);
            ring.hidden = right <= left || bottom <= top;
            if (!ring.hidden) Object.assign(ring.style, { left: `${left}px`, top: `${top}px`, width: `${right-left}px`, height: `${bottom-top}px` });
        } else ring.hidden = true;
        const { width, height } = card.getBoundingClientRect();
        const maxLeft = Math.max(margin, viewportWidth - width - margin);
        const maxTop = Math.max(topMargin, viewportHeight - height - margin);
        const leftSide = Math.min(76, maxLeft);
        const candidates = [
            { left: maxLeft, top: maxTop }, { left: leftSide, top: maxTop },
            { left: maxLeft, top: topMargin }, { left: leftSide, top: topMargin },
        ];
        const overlap = candidate => rect && !ring.hidden
            ? Math.max(0, Math.min(candidate.left + width, rect.right + 12) - Math.max(candidate.left, rect.left - 12))
              * Math.max(0, Math.min(candidate.top + height, rect.bottom + 12) - Math.max(candidate.top, rect.top - 12))
            : 0;
        const best = candidates.reduce((best, next) => overlap(next) < overlap(best) ? next : best);
        Object.assign(card.style, { left: `${best.left}px`, top: `${best.top}px`, right: 'auto', bottom: 'auto' });
    }
    function setMiguiMode(help) {
        $('#migui-tour-content').hidden = help;
        $('#assistant-panel').hidden = !help;
        $('#assistant-panel').open = true;
        $('#migui-tour-tab').setAttribute('aria-pressed', String(!help));
        $('#migui-help-tab').setAttribute('aria-pressed', String(help));
        $('#tutorial-next').hidden = help;
        $('#tutorial-back').hidden = help || tutorialHistory.length === 0;
        $('#tutorial-try').hidden = help || !tutorialTarget;
        requestAnimationFrame(positionTutorial);
        if (help) $('#assistant-input').focus({ preventScroll: true });
    }
    let assistantTopic = null;
    let assistantExpanded = false;
    function askLauncherAssistant(question) {
        const topic = window.MigajasAssistant.answer(question);
        assistantTopic = topic;
        $('#assistant-response').textContent = topic.answer;
        $('#assistant-go').hidden = !topic.step && !['release-notes','era-welcome'].includes(topic.action);
        $('#assistant-go').textContent = ['release-notes','era-welcome'].includes(topic.action) ? 'Cuéntame las novedades' : 'Llévame, Migui';
        $('.migui-scroll').scrollTop = 0;
        scheduleTutorialPosition();
    }
    function renderAssistantQuestions(step) {
        const root = $('#assistant-questions');
        root.replaceChildren();
        const topics = window.MigajasAssistant.topics;
        const related = topics.filter(topic => topic.step === step);
        const choices = [...related, ...topics.filter(topic => !related.includes(topic))];
        const more = $('#assistant-more');
        more.textContent = assistantExpanded ? 'Ver menos preguntas' : 'Ver más preguntas';
        more.setAttribute('aria-expanded', String(assistantExpanded));
        for (const topic of (assistantExpanded ? choices : choices.slice(0, 3))) {
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'btn-ghost'; button.textContent = topic.question;
            button.addEventListener('click', () => askLauncherAssistant(topic.question));
            root.append(button);
        }
    }
    function initTutorialHandlers() {
        $('#migui-tour-tab').addEventListener('click', () => setMiguiMode(false));
        $('#migui-help-tab').addEventListener('click', () => setMiguiMode(true));
        $('#migui-avatar').addEventListener('click', () => {
            const bird = $('#migui-avatar');
            bird.classList.remove('is-happy');
            requestAnimationFrame(() => bird.classList.add('is-happy'));
            $('#migui-caption').textContent = '¡Prrú! Tú pregunta, que yo te acompaño.';
        });
        $('#migui-minimize').addEventListener('click', () => {
            $('#tutorial-guide').classList.add('is-minimized');
            $('#migui-launcher').hidden = false;
            $('#migui-launcher').focus();
        });
        $('#migui-launcher').addEventListener('click', () => {
            $('#tutorial-guide').classList.remove('is-minimized');
            $('#migui-launcher').hidden = true;
            $('.tutorial-card').focus();
            positionTutorial();
        });
        $('#assistant-more').addEventListener('click', () => {
            assistantExpanded = !assistantExpanded;
            renderAssistantQuestions(state.tutorialStep);
        });
        $('#assistant-form').addEventListener('submit', event => {
            event.preventDefault();
            const input = $('#assistant-input');
            if (!input.value.trim()) { input.focus(); return; }
            askLauncherAssistant(input.value);
        });
        $('#assistant-go').addEventListener('click', async () => {
            if (tutorialBusy || !assistantTopic || (!assistantTopic.step && !['release-notes','era-welcome'].includes(assistantTopic.action)) || !state.tutorialStep) return;
            const topic = assistantTopic;
            tutorialBusy = true;
            $('#assistant-go').disabled = true;
            const previousStep = state.tutorialStep;
            try {
                if (topic.action === 'release-notes') { await window.MigajasNews.open(); return; }
                if (topic.action === 'era-welcome') { await window.MigajasNews.openWelcome(); return; }
                if (topic.step === 'game-settings') {
                    if (!state.selectedInstance) {
                        $('#assistant-response').textContent = 'Primero elige un evento. Te muestro el catálogo; después vuelve a hacerme esta pregunta.';
                        showTutorialStep('catalog');
                        return;
                    }
                    await openInstanceSettings(state.selectedInstance.id);
                    if (state.tutorialStep !== previousStep) { closeModal('instance-settings-modal'); return; }
                }
                showTutorialStep(topic.step);
                setMiguiMode(false);
                $('#assistant-response').textContent = topic.answer;
            } catch (error) {
                $('#assistant-response').textContent = error?.message || 'No pude abrir esta sección. Inténtalo otra vez.';
            } finally {
                tutorialBusy = false;
                $('#assistant-go').disabled = false;
            }
        });
        window.addEventListener('resize', scheduleTutorialPosition);
        document.addEventListener('transitionend', event => {
            if (tutorialTarget && event.target instanceof Element && event.target.contains(tutorialTarget)) scheduleTutorialPosition();
        });
        new ResizeObserver(scheduleTutorialPosition).observe($('.tutorial-card'));
        document.addEventListener('scroll', scheduleTutorialPosition, true);
        $('#tutorial-back').addEventListener('click', () => {
            if (tutorialBusy || !tutorialHistory.length) return;
            showTutorialStep(tutorialHistory.pop(), false);
        });
        $('#tutorial-try').addEventListener('click', () => {
            if (!tutorialTarget) return;
            tutorialTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const control = tutorialTarget.matches('button, input, select, a, textarea') ? tutorialTarget : tutorialTarget.querySelector('button, input, select, a, textarea');
            control?.focus({ preventScroll: true });
            positionTutorial();
        });
        $('#tutorial-next')?.addEventListener('click', advanceTutorial);
        $('#tutorial-skip')?.addEventListener('click', () => finishTutorial(false));
    }

    async function advanceTutorial() {
        if (tutorialBusy) return;
        tutorialBusy = true;
        $('#tutorial-next').disabled = true;
        try {
        switch (state.tutorialStep) {
            case 'welcome':
                showTutorialStep('catalog');
                break;
            case 'catalog': {
                const first = state.selectedInstance || state.events[0];
                if (!first) { showTutorialStep('empty'); break; }
                selectInstance(first.id);
                navigateTo('hero');
                showTutorialStep('play');
                break;
            }
            case 'empty':
                showTutorialStep('skin');
                break;
            case 'play':
                showTutorialStep('skin');
                break;
            case 'skin':
                closeModal('skin-modal');
                openSettingsForTutorial();
                showTutorialStep('ram');
                break;
            case 'ram':
                closeModal('settings-modal');
                if (state.selectedInstance) {
                    await openInstanceSettings(state.selectedInstance.id);
                    if (state.tutorialStep !== 'ram') { closeModal('instance-settings-modal'); break; }
                    showTutorialStep('game-settings');
                } else {
                    showTutorialStep('game-settings-empty');
                }
                break;
            case 'game-settings':
            case 'game-settings-empty':
                closeModal('instance-settings-modal');
                navigateTo('instances');
                showTutorialStep('delete');
                break;
            case 'delete':
                hideInstanceContextMenu();
                closeDrawer();
                showTutorialStep('friends');
                break;
            case 'friends':
                closeModal('friends-modal');
                $('#profile-drawer')?.classList.add('open');
                $('#drawer-backdrop')?.classList.add('open');
                showTutorialStep('discord');
                break;
            default:
                finishTutorial(true);
        }
        } catch (error) {
            $('#tutorial-task').textContent = error?.message || 'No pudimos abrir esta sección. Puedes volver atrás o salir y reintentar.';
        } finally {
            tutorialBusy = false;
            $('#tutorial-next').disabled = false;
        }
    }

    function startTutorial(automatic) {
        if (automatic && localStorage.getItem('migajasTutorialSeenV2') === '1') return;
        tutorialReturnFocus = document.activeElement;
        tutorialHistory = [];
        assistantTopic = null;
        assistantExpanded = false;
        $('#assistant-go').hidden = true;
        $('#assistant-input').value = '';
        $('#assistant-response').textContent = '¡Prrú! Soy Migui. ¿Qué quieres hacer hoy? Elige una pregunta o cuéntamelo con tus palabras.';
        $$('.modal-overlay.open').forEach(modal => closeModal(modal.id));
        closeDrawer();
        hideInstanceContextMenu();
        navigateTo('instances');
        $('#tutorial-guide').classList.remove('is-minimized');
        $('#migui-launcher').hidden = true;
        setMiguiMode(false);
        $('#tutorial-guide').hidden = false;
        showTutorialStep('welcome');
    }

    function showTutorialStep(step, remember = true) {
        if (remember && state.tutorialStep && state.tutorialStep !== step) tutorialHistory.push(state.tutorialStep);
        $$('.modal-overlay.open').forEach(modal => closeModal(modal.id));
        closeDrawer();
        hideInstanceContextMenu();
        if (step === 'play') navigateTo('hero');
        if (['welcome', 'catalog', 'delete', 'empty'].includes(step)) navigateTo('instances');
        $$('.tutorial-focus').forEach(element => element.classList.remove('tutorial-focus'));
        state.tutorialStep = step;
        const copy = {
            welcome: {
                label: 'ASISTENTE MIGAJAS · 1 DE 9', title: '¡Prrú! Soy Migui. ¿Lo vemos juntos?',
                description: '¿Qué te gustaría hacer? Pregúntame abajo o pulsa Empezar para que te guíe paso a paso por los eventos, tu skin, los ajustes y los amigos. Puedes preguntarme en cualquier momento del recorrido.',
                button: 'Empezar', target: null,
            },
            catalog: {
                label: 'RECORRIDO · 2 DE 9', title: 'Eventos disponibles',
                description: 'Aquí aparecen los eventos publicados. Cada uno tiene su propia versión de Minecraft, mods y jugadores. Elige una tarjeta o pulsa Siguiente para abrir el primer evento.',
                button: state.events.length ? 'Abrir primer evento' : 'Continuar', target: '.instance-card',
            },
            play: {
                label: 'RECORRIDO · 3 DE 9', title: 'Cómo entrar al evento',
                description: `Este botón inicia «${state.selectedInstance?.nombre_evento || 'el evento elegido'}». La primera vez se descargan Minecraft y sus mods; puede tardar unos minutos y el avance aparece en la barra. Hoy solo estamos recorriendo el launcher; pulsa Siguiente para continuar.`,
                button: 'Ver mi perfil', target: '#launch-play-btn',
            },
            skin: {
                label: 'RECORRIDO · 4 DE 9', title: 'Tu perfil y tu skin',
                description: 'Puedes elegir una imagen PNG de skin, previsualizarla y aplicarla a tu cuenta Microsoft. Las cuentas offline solo cambian la vista previa local. No tienes que cambiar nada ahora.',
                button: 'Ver memoria y ajustes', target: '#skin-pick-btn',
            },
            ram: {
                label: 'RECORRIDO · 5 DE 9', title: 'Memoria para Minecraft',
                description: 'Aquí decides cuánta memoria RAM puede usar el juego. Si no sabes qué valor poner, conserva el que ya está. No asignes toda la memoria de tu computadora: Windows y otros programas también la necesitan. En esta ventana también puedes cambiar el tema y la velocidad de descarga.',
                button: 'Ver ajustes del juego', target: '#settings-ram-max',
            },
            'game-settings': {
                label: 'RECORRIDO · 6 DE 9', title: 'Ajustes dentro del juego',
                description: 'Desde la configuración de una instancia puedes cambiar gráficos, FOV, sensibilidad, volumen, controles —incluidos los de mods— y paquetes de recursos. Estos cambios afectan solo a este evento.',
                button: 'Ver cómo borrar una instancia', target: '#instance-settings-title',
            },
            'game-settings-empty': {
                label: 'RECORRIDO · 6 DE 9', title: 'Ajustes de cada evento',
                description: 'Al seleccionar un evento podrás abrir su configuración y cambiar gráficos, FOV, sensibilidad, volumen, controles y paquetes de recursos. Cada evento guarda sus propios ajustes.',
                button: 'Ver cómo borrar una instancia', target: null,
            },
            delete: {
                label: 'RECORRIDO · 7 DE 9', title: 'Eliminar una instancia',
                description: 'Haz clic derecho sobre una instancia de la barra lateral para abrir su menú. Elige Eliminar instancia para borrar sus archivos locales y liberar espacio. Solo se habilita para instalaciones que Migajas puede identificar y borrar con seguridad.',
                button: 'Ver amigos y actividad', target: state.events.length ? '#sidebar-instances' : null,
            },
            friends: {
                label: 'RECORRIDO · 8 DE 9', title: 'Amigos y whitelist',
                description: 'En Amigos y actividad puedes buscar jugadores por su nombre de Minecraft, enviar y aceptar solicitudes, ver quién está conectado o jugando y consultar quién aparece en la whitelist del evento.',
                button: 'Continuar', target: '#social-add-toggle',
            },
            discord: {
                label: 'RECORRIDO · 9 DE 9', title: 'Únete al Discord',
                description: 'En este enlace puedes entrar a la comunidad, pedir ayuda y enterarte de los próximos eventos. El tutorial se puede volver a abrir desde el menú de tu perfil.',
                button: 'Finalizar recorrido', target: '#discord-invite',
            },
            empty: {
                label: 'RECORRIDO', title: 'Todavía no hay eventos',
                description: 'Cuando se publique un evento aparecerá aquí. Mientras tanto puedes conocer tu perfil y los ajustes del launcher. El tutorial siempre estará en el menú de tu perfil.',
                button: 'Continuar', target: null,
            },
        }[step];
        if (!copy) return;
        if (step === 'skin') { closeDrawer(); openSkinModal(); }
        if (step === 'ram') openSettingsForTutorial();
        if (step === 'game-settings') openModal('instance-settings-modal');
        if (step === 'friends') openFriendsModal();
        if (step === 'discord') { closeDrawer(); $('#profile-drawer')?.classList.add('open'); $('#drawer-backdrop')?.classList.add('open'); }
        renderAssistantQuestions(step);
        $('.migui-scroll').scrollTop = 0;
        $('#tutorial-step-label').textContent = copy.label;
        $('#tutorial-title').textContent = copy.title;
        $('#tutorial-description').textContent = copy.description;
        $('#tutorial-next').textContent = copy.button;
        const tasks = {
            welcome: 'A tu ritmo: puedes ir atrás o salir en cualquier momento. No hace falta saber de Minecraft.',
            catalog: 'Prueba: haz clic en una tarjeta para conocer ese evento.',
            play: 'Cuando quieras jugar, pulsa PLAY. Para seguir el recorrido no hace falta descargar nada.',
            skin: 'Prueba: localiza el botón para elegir una skin PNG. Solo se aplica cuando tú lo confirmas.',
            ram: 'Prueba: localiza la memoria máxima. Si tienes dudas, conserva el valor recomendado.',
            'game-settings': 'Explora los controles, el volumen y los gráficos. Pulsa Guardar cambios solo si quieres conservar tus ajustes.',
            delete: 'Prueba: clic derecho en un evento para ver sus opciones. El borrado siempre pide confirmación.',
            friends: 'Prueba: abre Añadir amigo y escribe su nombre. La solicitud se envía cuando tú pulses el botón.',
            discord: '¡Listo! Puedes entrar al Discord para pedir ayuda o compartir comentarios.',
        };
        $('#tutorial-task').textContent = tasks[step] || 'Puedes continuar aunque todavía no haya eventos disponibles.';
        const normalizedStep = step === 'game-settings-empty' ? 'game-settings' : step === 'empty' ? 'catalog' : step;
        const progress = tutorialOrder.indexOf(normalizedStep);
        $('#tutorial-progress').innerHTML = tutorialOrder.map((_, i) => `<span class="${i <= progress ? 'done' : ''}"></span>`).join('');
        $('#tutorial-back').disabled = tutorialHistory.length === 0;
        $('#tutorial-back').hidden = !$('#assistant-panel').hidden || tutorialHistory.length === 0;
        tutorialTarget = copy.target ? document.querySelector(copy.target) : null;
        $('#tutorial-try').hidden = !tutorialTarget;
        $('.tutorial-card').focus({ preventScroll: true });
        requestAnimationFrame(positionTutorial);
        if (copy.target) {
            const target = document.querySelector(copy.target);
            if (target && !target.closest('[hidden]')) {
                // El foco visual se dibuja fuera del modal para no alterar su apilamiento.
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }

    function openSettingsForTutorial() {
        $('#settings-ram-min').value = localStorage.getItem('migajasRamMin') || '1024';
        $('#settings-ram-max').value = localStorage.getItem('migajasRamMax') || '4096';
        openModal('settings-modal');
    }

    function finishTutorial(completed = false) {
        $$('.tutorial-focus').forEach(element => element.classList.remove('tutorial-focus'));
        $('#tutorial-guide').hidden = true;
        $('#tutorial-guide').classList.remove('is-minimized');
        $('#migui-launcher').hidden = true;
        state.tutorialStep = null;
        tutorialTarget = null;
        $('#tutorial-spotlight').hidden = true;
        closeDrawer();
        tutorialReturnFocus?.focus?.();
        $$('.modal-overlay.open').forEach(modal => closeModal(modal.id));
        hideInstanceContextMenu();
        localStorage.setItem('migajasTutorialSeenV2', '1');
        if (completed) flashLaunchStatus('Recorrido completado. ¡Ya puedes explorar Migajas Launcher!', 'success');
        document.dispatchEvent(new Event('migajas-tutorial-ended'));
    }
    function expandGistJsonEditor(expanded) {
        const modal = $('#settings-modal');
        const button = $('#gist-json-expand');
        if (!modal || !button) return;
        modal.classList.toggle('json-editor-expanded', Boolean(expanded));
        button.setAttribute('aria-expanded', String(Boolean(expanded)));
        button.textContent = expanded ? 'Reducir editor' : 'Ampliar editor';
        if (expanded) {
            requestAnimationFrame(() => $('#gist-events-json')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
        }
    }
    function closeModal(id) {
        document.getElementById(id)?.classList.remove('open');
        if (id === 'friends-modal' && state.socialRefreshTimer) {
            clearInterval(state.socialRefreshTimer);
            state.socialRefreshTimer = null;
        }
        if (id === 'settings-modal') {
            lockWhitelistAdminUi();
            expandGistJsonEditor(false);
        }
        if (id === 'instance-settings-modal') cancelControlBinding();
    }

    document.addEventListener('click', (e) => {
        const overlay = e.target.closest('.modal-overlay');
        if (overlay && e.target === overlay && !['settings-modal', 'instance-settings-modal'].includes(overlay.id)) {
            closeModal(overlay.id);
        }
    }, true);

    document.addEventListener('contextmenu', event => {
        const editable = event.target.closest('input, textarea, [contenteditable="true"]');
        if (!editable) event.preventDefault();
    }, true);

    document.addEventListener('keydown', (e) => {
        const editable = e.target.closest('input, textarea, [contenteditable="true"]');
        const copyShortcut = (e.ctrlKey || e.metaKey) && ['a', 'c', 'v', 'x'].includes(e.key.toLowerCase());
        if (!editable && !copyShortcut) {
            const browserShortcut = e.key === 'F5'
                || (e.altKey && ['ArrowLeft', 'ArrowRight', 'Backspace'].includes(e.key))
                || ((e.ctrlKey || e.metaKey) && ['r', 'p', 's', 'u', 'w', 'n', 'o'].includes(e.key.toLowerCase()))
                || ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c'].includes(e.key.toLowerCase()));
            if (browserShortcut) {
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
        }
        if (state.pendingControlBinding) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.key === 'Escape') {
                cancelControlBinding();
            } else if (!e.repeat) {
                assignControlBinding(keyNameFromEvent(e));
            }
            return;
        }
        if (e.key === 'Escape' && state.tutorialStep) {
            e.preventDefault();
            finishTutorial(false);
            return;
        }
        if (e.key === 'Escape') {
            hideInstanceContextMenu();
            $$('.modal-overlay.open').forEach(m => closeModal(m.id));
            closeDrawer();
        }
    }, true);

    /* ═══════════════════════════════════════════════════════════════════
       MODAL: SKIN EDITOR
       ═══════════════════════════════════════════════════════════════════ */
    function openSkinModal() {
        if (state.skinViewer && state.creds?.skinUrl) {
            safeCall(() => state.skinViewer.loadSkin(state.creds.skinUrl, { model: state.skinModel }));
        }
        updateModelButtons();
        openModal('skin-modal');
    }

    function updateModelButtons() {
        $$('.model-btn').forEach(b => {
            b.classList.toggle('active', (b.dataset.model === 'slim') === (state.skinModel === 'slim'));
        });
    }

    function initSkinModalHandlers() {
        $$('[data-close]').forEach(btn => {
            btn.addEventListener('click', () => closeModal(btn.dataset.close));
        });

        $$('.model-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                state.skinModel = btn.dataset.model === 'slim' ? 'slim' : 'default';
                updateModelButtons();
                const texture = state.pendingSkinTexture || state.creds?.skinUrl;
                if (texture && state.skinViewer) {
                    await safeCall(() => state.skinViewer.loadSkin(texture, { model: state.skinModel }));
                }
            });
        });

        $('#skin-pick-btn')?.addEventListener('click', () => $('#skin-upload')?.click());

        $('#skin-upload')?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;

            const dataUrl = await new Promise((res) => {
                const r = new FileReader();
                r.onload = ev => res(ev.target.result);
                r.readAsDataURL(file);
            });

            state.pendingSkinTexture = dataUrl;
            $('#skin-file-name').textContent = file.name;

            if (state.skinViewer) {
                state.skinViewer.autoRotate = false;
                await safeCall(() => state.skinViewer.loadSkin(dataUrl, { model: state.skinModel }));
            }
            e.target.value = '';
        });

        $('#skin-apply-btn')?.addEventListener('click', async () => {
            const texture = state.pendingSkinTexture || state.creds?.skinUrl;
            if (!texture) {
                alert('Selecciona un archivo PNG primero.');
                return;
            }

            const btn = $('#skin-apply-btn');
            btn.disabled = true;
            btn.textContent = 'Aplicando...';

            const offlineAccount = state.creds?.meta || String(state.creds?.accountType || '').toLowerCase() === 'offline';
            if (offlineAccount) {
                state.creds.skinUrl = texture;
                state.pendingSkinTexture = null;
                await updateProfileFaceFromSkin(texture);
                alert('La skin se aplicó a la vista previa de este launcher. Las cuentas sin conexión no pueden publicarla en Minecraft.net.');
                closeModal('skin-modal');
                btn.disabled = false;
                btn.textContent = 'Aplicar skin';
                return;
            }

            try {
                const res = await window.launcherAPI.cambiarSkin({
                    uuid: state.creds.uuid || state.creds.id,
                    imageDataUrl: texture,
                    model: state.skinModel,
                });
                if (!res?.success) throw new Error(res?.error || 'Minecraft no confirmó el cambio de skin.');
                state.creds.skinUrl = res.skinUrl || texture;
                state.pendingSkinTexture = null;
                if (state.skinViewer) await safeCall(() => state.skinViewer.loadSkin(state.creds.skinUrl, { model: state.skinModel }));
                await updateProfileFaceFromSkin(state.creds.skinUrl);
                alert('¡Skin actualizada en tu perfil de Minecraft!');
                closeModal('skin-modal');
            } catch (error) {
                alert('No se pudo cambiar la skin: ' + (error?.message || error));
            } finally {
                btn.disabled = false;
                btn.textContent = 'Aplicar skin';
            }
        });
    }

    /* ═══════════════════════════════════════════════════════════════════
       MODAL: SETTINGS (+ Zona de peligro)
       ═══════════════════════════════════════════════════════════════════ */
    async function openSettingsModal() {
        const ramMin = localStorage.getItem('migajasRamMin') || '1024';
        const ramMax = localStorage.getItem('migajasRamMax') || '4096';
        const jvmArgs = localStorage.getItem('migajasJvmArgs') || '';
        const fullscreen = localStorage.getItem('migajasFullscreen') === '1';
        const autoupdate = localStorage.getItem('migajasAutoupdate') !== '0';
        const verify = localStorage.getItem('migajasVerify') !== '0';
        const downloadLimitKbps = Number.parseInt(localStorage.getItem('migajasDownloadLimitKbps') || '0', 10);

        $('#settings-ram-min').value = ramMin;
        $('#settings-ram-max').value = ramMax;
        $('#settings-jvm').value = jvmArgs;
        $('#settings-fullscreen').checked = fullscreen;
        $('#settings-autoupdate').checked = autoupdate;
        $('#settings-verify').checked = verify;
        $('#settings-download-limit').value = downloadLimitKbps > 0 ? (downloadLimitKbps / 1024).toFixed(1).replace(/\.0$/, '') : '0';

        const dangerSection = $('#settings-danger-section');
        if (dangerSection) dangerSection.hidden = true;

        const instanceId = state.selectedInstance?.id;
        if (instanceId && typeof window.launcherAPI?.isMigajasInstance === 'function') {
            try {
                const isManaged = await window.launcherAPI.isMigajasInstance(instanceId);
                if (isManaged && dangerSection) dangerSection.hidden = false;
            } catch (err) {
                console.warn('[settings] isMigajasInstance falló:', err);
            }
        }

        expandGistJsonEditor(false);
        openModal('settings-modal');
        await refreshLocalInstances();
        await refreshGistEditorStatus();
    }

    const INSTANCE_CONTROL_DEFINITIONS = [
        ['key.attack', 'Atacar / destruir'], ['key.use', 'Usar / colocar'],
        ['key.forward', 'Avanzar'], ['key.back', 'Retroceder'], ['key.left', 'Moverse a la izquierda'], ['key.right', 'Moverse a la derecha'],
        ['key.jump', 'Saltar'], ['key.sneak', 'Agacharse'], ['key.sprint', 'Correr'],
        ['key.drop', 'Soltar objeto'], ['key.inventory', 'Inventario'], ['key.chat', 'Chat'], ['key.playerlist', 'Lista de jugadores'],
        ['key.pickItem', 'Tomar bloque'], ['key.command', 'Comandos'], ['key.togglePerspective', 'Cambiar perspectiva'],
        ['key.screenshot', 'Captura de pantalla'], ['key.fullscreen', 'Pantalla completa'], ['key.swapOffhand', 'Cambiar mano secundaria'],
        ...Array.from({ length: 9 }, (_, index) => [`key.hotbar.${index + 1}`, `Slot ${index + 1} del inventario`]),
    ];
    const INSTANCE_DEFAULT_CONTROLS = {
        'key.attack': 'key.mouse.left', 'key.use': 'key.mouse.right',
        'key.forward': 'key.keyboard.w', 'key.back': 'key.keyboard.s',
        'key.left': 'key.keyboard.a', 'key.right': 'key.keyboard.d',
        'key.jump': 'key.keyboard.space', 'key.sneak': 'key.keyboard.left.shift',
        'key.sprint': 'key.keyboard.left.control', 'key.drop': 'key.keyboard.q',
        'key.inventory': 'key.keyboard.e', 'key.chat': 'key.keyboard.t',
        'key.playerlist': 'key.keyboard.tab', 'key.pickItem': 'key.mouse.middle',
        'key.command': 'key.keyboard.slash', 'key.togglePerspective': 'key.keyboard.f5',
        'key.screenshot': 'key.keyboard.f2', 'key.fullscreen': 'key.keyboard.f11',
        'key.swapOffhand': 'key.keyboard.f',
        ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`key.hotbar.${index + 1}`, `key.keyboard.${index + 1}`])),
    };
    const INSTANCE_CONTROL_LABELS = Object.fromEntries(INSTANCE_CONTROL_DEFINITIONS);
    const INSTANCE_AUDIO_CONTROLS = [
        ['master', 'Volumen general'], ['music', 'Música'], ['record', 'Discos y sonidos'],
        ['weather', 'Clima'], ['block', 'Bloques'], ['hostile', 'Criaturas hostiles'],
        ['neutral', 'Criaturas'], ['player', 'Jugadores'], ['ambient', 'Ambiente'], ['voice', 'Voz'],
    ];

    async function openInstanceSettings(instanceId) {
        const instance = [...state.events, ...downloadedArchivedEvents()].find(event => event.id === instanceId);
        if (!instance) return;
        state.activeInstanceSettingsId = instanceId;
        $('#instance-settings-name').textContent = instance.nombre_evento || instance.id;
        $('#instance-settings-status').textContent = 'Cargando ajustes del juego…';
        $('#instance-settings-status').style.color = '';
        $('#instance-settings-save').disabled = true;
        openModal('instance-settings-modal');
        try {
            const [options, resourcePacks] = await Promise.all([
                window.launcherAPI.getGameOptions(instanceId),
                window.launcherAPI.listResourcePacks(instanceId),
            ]);
            state.instanceGameOptions = options;
            state.instanceGameOptions.controls = {
                ...INSTANCE_DEFAULT_CONTROLS,
                ...(options.controls || {}),
            };
            renderInstanceSettings(options, resourcePacks);
            $('#instance-settings-status').textContent = 'Los cambios se guardan en esta instancia y se aplican al iniciar Minecraft.';
            $('#instance-copy-panel').classList.remove('open');
            $('#instance-copy-list').replaceChildren();
            $('#instance-copy-select-all').checked = false;
        } catch (error) {
            state.instanceGameOptions = null;
            $('#instance-settings-status').textContent = `No se pudieron cargar los ajustes: ${error?.message || error}`;
            $('#instance-settings-status').style.color = '#f87171';
        } finally {
            $('#instance-settings-save').disabled = !state.instanceGameOptions;
        }
    }

    function renderInstanceSettings(options, resourcePacks) {
        const graphics = options.graphics || {};
        $('#instance-fov').value = String(Math.min(110, Math.max(30, graphics.fov ?? 70)));
        $('#instance-render-distance').value = String(Math.min(32, Math.max(2, graphics.renderDistance ?? 12)));
        $('#instance-max-fps').value = String([30, 60, 120, 144, 165, 240, 260].includes(graphics.maxFps) ? graphics.maxFps : 120);
        $('#instance-gui-scale').value = String(Math.min(4, Math.max(0, graphics.guiScale ?? 0)));
        $('#instance-graphics-mode').value = ['fast', 'fancy', 'fabulous'].includes(graphics.graphicsMode) ? graphics.graphicsMode : 'fancy';
        $('#instance-fullscreen').checked = Boolean(graphics.fullscreen);
        setInstanceRange('instance-gamma', graphics.gamma ?? 0.5);
        $('#instance-sensitivity').value = (Number(options.mouseSensitivity ?? 0.5)).toFixed(2);

        const audioRoot = $('#instance-audio-controls');
        audioRoot.replaceChildren();
        for (const [key, label] of INSTANCE_AUDIO_CONTROLS) {
            const row = document.createElement('div');
            row.className = 'instance-range-row';
            const inputId = `instance-audio-${key}`;
            const labelNode = document.createElement('label');
            labelNode.htmlFor = inputId;
            labelNode.textContent = label;
            const input = document.createElement('input');
            input.type = 'range'; input.id = inputId; input.min = '0'; input.max = '1'; input.step = '0.01';
            input.value = String(Math.max(0, Math.min(1, options.audio?.[key] ?? 1)));
            const output = document.createElement('output');
            output.className = 'instance-range-value'; output.htmlFor = inputId;
            output.textContent = `${Math.round(Number(input.value) * 100)}%`;
            input.addEventListener('input', () => { output.textContent = `${Math.round(Number(input.value) * 100)}%`; });
            row.append(labelNode, input, output);
            audioRoot.appendChild(row);
        }

        const controlRoot = $('#instance-controls-grid');
        controlRoot.replaceChildren();
        const orderedActions = [
            ...INSTANCE_CONTROL_DEFINITIONS.map(([action]) => action),
            ...Object.keys(state.instanceGameOptions.controls)
                .filter(action => !INSTANCE_CONTROL_LABELS[action])
                .sort((left, right) => left.localeCompare(right)),
        ];
        for (const action of orderedActions) {
            const label = INSTANCE_CONTROL_LABELS[action] || labelForModControl(action);
            const row = document.createElement('div');
            row.className = 'instance-control-row';
            const labelNode = document.createElement('span');
            labelNode.className = 'instance-control-label'; labelNode.textContent = label;
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'instance-bind-button'; button.dataset.action = action;
            button.dataset.current = state.instanceGameOptions.controls[action] || INSTANCE_DEFAULT_CONTROLS[action] || '';
            button.textContent = displayControlBinding(button.dataset.current);
            button.addEventListener('click', () => {
                if (state.pendingControlBinding) cancelControlBinding();
                state.pendingControlBinding = { action, button };
                button.classList.add('waiting');
                button.textContent = 'Presiona una tecla…';
            });
            row.append(labelNode, button);
            controlRoot.appendChild(row);
        }

        const packRoot = $('#instance-resourcepack-list');
        packRoot.replaceChildren();
        const packs = Array.isArray(resourcePacks) ? resourcePacks : [];
        if (!packs.length) {
            $('#instance-resourcepacks-hint').textContent = 'No hay paquetes de recursos instalados en esta instancia.';
        } else {
            $('#instance-resourcepacks-hint').textContent = 'Marca los paquetes que quieras usar. Los cambios se aplican al iniciar Minecraft.';
        }
        for (const pack of packs) {
            const row = document.createElement('label');
            row.className = 'instance-resourcepack-row';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox'; checkbox.dataset.resourcePackId = pack.id; checkbox.checked = Boolean(pack.active);
            checkbox.setAttribute('aria-label', `Activar paquete ${pack.name}`);
            if (pack.iconDataUrl) {
                const icon = document.createElement('img'); icon.src = pack.iconDataUrl; icon.alt = '';
                row.appendChild(icon);
            }
            const info = document.createElement('span'); info.className = 'instance-resourcepack-info';
            info.append(document.createTextNode(pack.name || pack.id));
            const description = document.createElement('small'); description.textContent = pack.description || pack.id;
            info.appendChild(description);
            row.append(checkbox, info);
            packRoot.appendChild(row);
        }
    }

    function labelForModControl(action) {
        const name = String(action).replace(/^key\./, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        if (!name) return action;
        return `Mod: ${name.replace(/\b\p{L}/gu, letter => letter.toLocaleUpperCase())}`;
    }

    function setInstanceRange(id, value) {
        const input = $('#' + id);
        if (!input) return;
        input.value = String(Math.max(0, Math.min(1, Number(value) || 0)));
        const output = $('#' + id + '-value');
        if (output) output.textContent = `${Math.round(Number(input.value) * 100)}%`;
    }

    function displayControlBinding(value) {
        const friendly = {
            'key.mouse.left': 'Ratón izquierdo', 'key.mouse.right': 'Ratón derecho', 'key.mouse.middle': 'Rueda del ratón',
            'key.keyboard.space': 'Espacio', 'key.keyboard.left.shift': 'Shift izquierdo', 'key.keyboard.right.shift': 'Shift derecho',
            'key.keyboard.left.control': 'Ctrl izquierdo', 'key.keyboard.right.control': 'Ctrl derecho',
            'key.keyboard.left.alt': 'Alt izquierdo', 'key.keyboard.right.alt': 'Alt derecho',
        };
        if (friendly[value]) return friendly[value];
        return String(value || 'Sin asignar').replace(/^key\.keyboard\./, '').replaceAll('.', ' ').toUpperCase();
    }

    function keyNameFromEvent(event) {
        const special = {
            Space: 'space', Enter: 'enter', NumpadEnter: 'keypad.enter', Tab: 'tab', Backspace: 'backspace',
            Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'page.up', PageDown: 'page.down',
            ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
            ShiftLeft: 'left.shift', ShiftRight: 'right.shift', ControlLeft: 'left.control', ControlRight: 'right.control',
            AltLeft: 'left.alt', AltRight: 'right.alt', CapsLock: 'caps.lock', Escape: 'escape',
            Backquote: 'grave.accent', Minus: 'minus', Equal: 'equal', BracketLeft: 'left.bracket', BracketRight: 'right.bracket',
            Backslash: 'backslash', Semicolon: 'semicolon', Quote: 'apostrophe', Comma: 'comma', Period: 'period', Slash: 'slash',
        };
        let key = special[event.code];
        if (!key && /^Key[A-Z]$/.test(event.code)) key = event.code.slice(3).toLowerCase();
        if (!key && /^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
        if (!key && /^Numpad[0-9]$/.test(event.code)) key = `keypad.${event.code.slice(6)}`;
        if (!key && /^F([1-9]|1[0-2])$/.test(event.code)) key = event.code.toLowerCase();
        if (!key) key = String(event.key || '').toLowerCase();
        return key ? `key.keyboard.${key}` : '';
    }

    function assignControlBinding(value) {
        const pending = state.pendingControlBinding;
        if (!pending || !value) return;
        state.instanceGameOptions.controls[pending.action] = value;
        pending.button.dataset.current = value;
        pending.button.textContent = displayControlBinding(value);
        pending.button.classList.remove('waiting');
        state.pendingControlBinding = null;
    }

    function cancelControlBinding() {
        const pending = state.pendingControlBinding;
        if (!pending) return;
        pending.button.classList.remove('waiting');
        pending.button.textContent = displayControlBinding(pending.button.dataset.current);
        state.pendingControlBinding = null;
    }

    function initInstanceSettingsModalHandlers() {
        $('#instance-copy-toggle')?.addEventListener('click', async () => {
            const panel = $('#instance-copy-panel');
            panel.classList.toggle('open');
            if (!panel.classList.contains('open')) return;
            const list = $('#instance-copy-list');
            list.replaceChildren();
            try {
                const instances = await window.launcherAPI.listLocalInstances();
                state.localInstances = Array.isArray(instances) ? instances : [];
                const targets = state.localInstances.filter(item => item.instanceId !== state.activeInstanceSettingsId);
                if (!targets.length) {
                    const empty = document.createElement('span'); empty.className = 'instance-copy-description'; empty.textContent = 'No hay otras instancias locales.'; list.appendChild(empty);
                }
                for (const item of targets) {
                    const label = document.createElement('label'); label.className = 'instance-copy-item';
                    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.instanceId = item.instanceId;
                    const name = document.createElement('span'); name.textContent = item.name || item.instanceId;
                    label.append(checkbox, name); list.appendChild(label);
                }
            } catch (error) {
                const message = document.createElement('span'); message.className = 'instance-copy-description'; message.textContent = `No se pudieron cargar las instancias: ${error?.message || error}`; list.appendChild(message);
            }
        });
        $('#instance-copy-select-all')?.addEventListener('change', event => {
            $('#instance-copy-list').querySelectorAll('input[data-instance-id]').forEach(input => { input.checked = event.target.checked; });
        });
        $('#instance-copy-list')?.addEventListener('change', () => {
            const checks = [...$('#instance-copy-list').querySelectorAll('input[data-instance-id]')];
            $('#instance-copy-select-all').checked = checks.length > 0 && checks.every(input => input.checked);
        });
        $('#instance-copy-apply')?.addEventListener('click', async () => {
            const sourceId = state.activeInstanceSettingsId;
            if (!sourceId || !state.instanceGameOptions) return;
            const targetIds = [...$('#instance-copy-list').querySelectorAll('input[data-instance-id]:checked')].map(input => input.dataset.instanceId);
            if (!targetIds.length) { $('#instance-settings-status').textContent = 'Selecciona al menos una instancia.'; return; }
            const button = $('#instance-copy-apply'); const status = $('#instance-settings-status');
            button.disabled = true; status.style.color = ''; status.textContent = 'Copiando ajustes…';
            try {
                const sourceOptions = collectInstanceSettingsFromForm();
                let copied = 0; let failed = 0;
                for (const targetId of targetIds) {
                    try {
                        const [target, packs] = await Promise.all([
                            window.launcherAPI.getGameOptions(targetId),
                            window.launcherAPI.listResourcePacks(targetId),
                        ]);
                        const available = new Set((Array.isArray(packs) ? packs : []).map(pack => pack.id));
                        const mergedControls = { ...(target.controls || {}), ...sourceOptions.controls };
                        const copiedOptions = {
                            ...target,
                            graphics: { ...(target.graphics || {}), ...sourceOptions.graphics },
                            audio: { ...(target.audio || {}), ...sourceOptions.audio },
                            mouseSensitivity: sourceOptions.mouseSensitivity,
                            controls: mergedControls,
                            resourcePacks: sourceOptions.resourcePacks.filter(id => available.has(id)),
                        };
                        await window.launcherAPI.saveGameOptions(targetId, copiedOptions); copied++;
                    } catch (error) { console.error(`No se pudieron copiar ajustes a ${targetId}:`, error); failed++; }
                }
                status.textContent = `${copied} instancia${copied === 1 ? '' : 's'} actualizada${copied === 1 ? '' : 's'}${failed ? `; ${failed} con error` : ''}.`;
                if (failed) status.style.color = '#f87171';
            } finally { button.disabled = false; }
        });
        $('#instance-gamma')?.addEventListener('input', event => {
            const output = $('#instance-gamma-value');
            if (output) output.textContent = `${Math.round(Number(event.target.value) * 100)}%`;
        });
        document.addEventListener('pointerdown', event => {
            if (!state.pendingControlBinding) return;
            const mouseKeys = { 0: 'key.mouse.left', 1: 'key.mouse.middle', 2: 'key.mouse.right', 3: 'key.mouse.4', 4: 'key.mouse.5' };
            const value = mouseKeys[event.button];
            if (!value) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            state.bindingPointerCaptured = true;
            assignControlBinding(value);
        }, true);
        document.addEventListener('click', event => {
            if (!state.bindingPointerCaptured) return;
            state.bindingPointerCaptured = false;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
        $('#instance-settings-save')?.addEventListener('click', async () => {
            const instance = [...state.events, ...downloadedArchivedEvents()].find(event => event.id === state.activeInstanceSettingsId);
            if (!instance || !state.instanceGameOptions) return;
            const button = $('#instance-settings-save');
            const status = $('#instance-settings-status');
            const options = collectInstanceSettingsFromForm();
            button.disabled = true;
            status.style.color = '';
            status.textContent = 'Guardando configuración…';
            try {
                await window.launcherAPI.saveGameOptions(instance.id, options);
                status.textContent = 'Configuración guardada.';
                flashLaunchStatus('Configuración de instancia guardada', 'success');
            } catch (error) {
                status.style.color = '#f87171';
                status.textContent = `No se pudo guardar: ${error?.message || error}`;
            } finally {
                button.disabled = false;
            }
        });
    }

    function collectInstanceSettingsFromForm() {
        const options = structuredClone(state.instanceGameOptions);
        options.graphics ||= {}; options.audio ||= {}; options.controls ||= {};
        options.graphics.fov = Math.max(30, Math.min(110, Number.parseInt($('#instance-fov').value, 10) || 70));
        options.graphics.renderDistance = Math.max(2, Math.min(32, Number.parseInt($('#instance-render-distance').value, 10) || 12));
        options.graphics.maxFps = Number.parseInt($('#instance-max-fps').value, 10) || 120;
        options.graphics.guiScale = Math.max(0, Math.min(4, Number.parseInt($('#instance-gui-scale').value, 10) || 0));
        options.graphics.graphicsMode = $('#instance-graphics-mode').value;
        options.graphics.fullscreen = $('#instance-fullscreen').checked;
        options.graphics.gamma = Number.parseFloat($('#instance-gamma').value);
        const sensitivity = Number.parseFloat($('#instance-sensitivity').value);
        options.mouseSensitivity = Number.isFinite(sensitivity) ? Math.max(0, Math.min(1, sensitivity)) : 0.5;
        $('#instance-sensitivity').value = options.mouseSensitivity.toFixed(2);
        for (const [key] of INSTANCE_AUDIO_CONTROLS) options.audio[key] = Number.parseFloat($(`#instance-audio-${key}`).value);
        const selected = [...$('#instance-resourcepack-list').querySelectorAll('input[data-resource-pack-id]:checked')].map(input => input.dataset.resourcePackId);
        const selectedSet = new Set(selected);
        const prior = (options.resourcePacks || []).filter(pack => selectedSet.delete(pack));
        options.resourcePacks = [...prior, ...selectedSet];
        return options;
    }

    async function refreshLocalInstances() {
        const list = $('#local-instance-list');
        const status = $('#local-instances-status');
        if (!list || !status) return;
        list.replaceChildren();
        status.textContent = 'Buscando instalaciones locales…';
        status.style.color = '';
        try {
            const instances = await window.launcherAPI.listLocalInstances();
            state.localInstances = Array.isArray(instances) ? instances : [];
            renderSidebarInstances();
            if (state.localInstances.length === 0) {
                status.textContent = 'No se encontraron instancias locales anteriores.';
                return;
            }
            status.textContent = `${state.localInstances.length} instancia${state.localInstances.length === 1 ? '' : 's'} encontrada${state.localInstances.length === 1 ? '' : 's'}.`;
            for (const instance of state.localInstances) {
                const row = document.createElement('div');
                row.className = 'local-instance-row';
                const info = document.createElement('div');
                info.className = 'local-instance-info';
                const name = document.createElement('span');
                name.className = 'local-instance-name';
                name.textContent = instance.name || instance.instanceId;
                const id = document.createElement('span');
                id.className = 'local-instance-id';
                id.textContent = instance.instanceId;
                const badge = document.createElement('span');
                badge.className = 'local-instance-badge';
                badge.textContent = instance.legacy ? 'Instancia de una versión anterior' : 'Instancia de Migajas Launcher';
                info.append(name, id, badge);

                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'local-instance-delete';
                button.textContent = 'Eliminar';
                button.addEventListener('click', async () => {
                    const displayName = instance.name || instance.instanceId;
                    if (!confirm(`¿Seguro que deseas eliminar “${displayName}” y todos sus datos locales? Esta acción no se puede deshacer.`)) return;
                    button.disabled = true;
                    button.textContent = 'Eliminando…';
                    status.textContent = '';
                    try {
                        await window.launcherAPI.deletePreviousInstance(instance.instanceId);
                        if (state.selectedInstance?.id === instance.instanceId) {
                            state.selectedInstance = null;
                            $('#hero-bg').style.backgroundImage = 'none';
                            $('#hero-logo').style.display = 'none';
                            $('#hero-title').style.display = 'none';
                            $('#hero-sponsor-text').textContent = 'MIGAJAS STUDIO';
                            updateLaunchCardIdle();
                            $('#launch-play-btn').disabled = true;
                            $$('.sidebar-btn.instance-btn').forEach(item => item.classList.remove('is-selected'));
                            if (state.events.length) selectInstance(state.events[0].id);
                        }
                        await refreshLocalInstances();
                        flashLaunchStatus('Instancia local eliminada', 'success');
                    } catch (error) {
                        status.textContent = `No se pudo eliminar: ${error?.message || error}`;
                        status.style.color = '#f87171';
                        button.disabled = false;
                        button.textContent = 'Eliminar';
                    }
                });
                row.append(info, button);
                list.appendChild(row);
            }
        } catch (error) {
            state.localInstances = [];
            status.textContent = `No se pudieron consultar las instancias: ${error?.message || error}`;
            status.style.color = '#f87171';
        }
    }

    function setLauncherUpdaterStatus(message, isError = false) {
        const status = $('#launcher-updater-status');
        if (!status) return;
        status.textContent = message;
        status.style.color = isError ? '#f87171' : '';
    }

    let launcherUpdateBytesDownloaded = 0;

    async function installLauncherUpdate(version) {
        const installButton = $('#launcher-updater-install');
        const progress = $('#launcher-updater-progress');
        if (!window.launcherAPI?.updaterInstall) return;
        if (!confirm(`Se descargará e instalará la versión ${version}. El launcher se cerrará durante la instalación. ¿Continuar?`)) return;

        launcherUpdateBytesDownloaded = 0;
        if (installButton) installButton.disabled = true;
        if (progress) {
            progress.hidden = false;
            progress.value = 0;
        }
        setLauncherUpdaterStatus('Descargando y verificando la actualización…');

        try {
            await window.launcherAPI.updaterInstall();
            setLauncherUpdaterStatus('Descarga verificada. Iniciando el instalador…');
        } catch (error) {
            setLauncherUpdaterStatus(`No se pudo instalar la actualización: ${error?.message || error}`, true);
            if (installButton) installButton.disabled = false;
        }
    }

    async function checkLauncherUpdate(userInitiated = true) {
        const checkButton = $('#launcher-updater-check');
        const installButton = $('#launcher-updater-install');
        if (!window.launcherAPI?.updaterCheck) return;

        if (checkButton) checkButton.disabled = true;
        if (installButton) installButton.hidden = true;
        setLauncherUpdaterStatus('Buscando actualizaciones…');

        try {
            const result = await window.launcherAPI.updaterCheck();
            if (!result?.available) {
                setLauncherUpdaterStatus(`Tienes la versión más reciente (${result?.currentVersion || 'actual'}).`);
                return;
            }

            setLauncherUpdaterStatus(`Está disponible la versión ${result.version}. ${result.notes || ''}`);
            if (result.notes) try { localStorage.setItem('migajasPendingReleaseNotes', JSON.stringify({ version: result.version, notes: String(result.notes).slice(0, 16000) })); } catch {}
            if (installButton) {
                installButton.hidden = false;
                installButton.disabled = false;
                installButton.onclick = () => installLauncherUpdate(result.version);
            }

            if (!userInitiated && localStorage.getItem('migajasAutoupdate') !== '0') {
                installLauncherUpdate(result.version);
            }
        } catch (error) {
            setLauncherUpdaterStatus(`No se pudo buscar actualizaciones: ${error?.message || error}`, true);
        } finally {
            if (checkButton) checkButton.disabled = false;
        }
    }

    function initLauncherUpdater() {
        const section = $('#launcher-updater-section');
        if (!section || typeof window.launcherAPI?.updaterCheck !== 'function') return;
        section.hidden = false;
        $('#launcher-updater-check')?.addEventListener('click', () => checkLauncherUpdate(true));

        window.launcherAPI.onUpdaterProgress?.(({ chunkLength, contentLength }) => {
            const progress = $('#launcher-updater-progress');
            if (!progress || !Number.isFinite(contentLength) || contentLength <= 0) return;
            launcherUpdateBytesDownloaded += chunkLength;
            progress.value = Math.min(100, Math.round((launcherUpdateBytesDownloaded / contentLength) * 100));
            setLauncherUpdaterStatus(`Descargando actualización: ${progress.value}%`);
            flashLaunchStatus(`Descargando actualización del launcher: ${progress.value}%`, 'info');
        });
        window.launcherAPI.onUpdaterDownloaded?.(() => {
            const progress = $('#launcher-updater-progress');
            if (progress) progress.value = 100;
            setLauncherUpdaterStatus('Descarga y firma verificadas. Abriendo el instalador…');
        });
    }

    function initSettingsModalHandlers() {
        $('#settings-save')?.addEventListener('click', () => {
            const ramMin = parseInt($('#settings-ram-min').value, 10) || 1024;
            const ramMax = parseInt($('#settings-ram-max').value, 10) || 4096;
            const downloadLimitMbps = Number.parseFloat($('#settings-download-limit').value);

            if (ramMin > ramMax) {
                alert('La memoria mínima no puede ser mayor que la máxima.');
                return;
            }
            if (!Number.isFinite(downloadLimitMbps) || downloadLimitMbps < 0 || downloadLimitMbps > 1000) {
                alert('El límite de descarga debe estar entre 0 y 1000 MB/s. Usa 0 para quitar el límite.');
                return;
            }

            localStorage.setItem('migajasRamMin', ramMin);
            localStorage.setItem('migajasRamMax', ramMax);
            localStorage.setItem('migajasJvmArgs', $('#settings-jvm').value.trim());
            localStorage.setItem('migajasFullscreen', $('#settings-fullscreen').checked ? '1' : '0');
            localStorage.setItem('migajasAutoupdate', $('#settings-autoupdate').checked ? '1' : '0');
            localStorage.setItem('migajasVerify', $('#settings-verify').checked ? '1' : '0');
            localStorage.setItem('migajasDownloadLimitKbps', String(Math.round(downloadLimitMbps * 1024)));

            closeModal('settings-modal');
            flashLaunchStatus('Configuración guardada', 'success');
        });

        $('#settings-delete-btn')?.addEventListener('click', async () => {
            const instanceId = state.selectedInstance?.id;
            if (!instanceId) return;

            if (!confirm('¿Seguro que deseas eliminar esta instancia y todos sus archivos locales?')) return;

            const btn = $('#settings-delete-btn');
            const originalHTML = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Eliminando...';

            try {
                await window.launcherAPI.deleteInstance(instanceId);

                closeModal('settings-modal');
                state.selectedInstance = null;
                $('#hero-bg').style.backgroundImage = 'none';
                $('#hero-logo').style.display = 'none';
                $('#hero-title').style.display = 'none';
                $('#hero-sponsor-text').textContent = 'MIGAJAS STUDIO';

                updateLaunchCardIdle();
                $('#launch-play-btn').disabled = true;

                await loadEvents();
                navigateTo('instances');

                flashLaunchStatus('Instancia eliminada', 'success');
            } catch (err) {
                alert('Error al eliminar la instancia: ' + (err?.message || err));
                btn.disabled = false;
                btn.innerHTML = originalHTML;
            }
        });
    }

    function setGistEditorConnected(access) {
        $('#gist-connect-panel').hidden = Boolean(access);
        $('#gist-editor-panel').hidden = !access;
        if (access) {
            $('#gist-connected-user').textContent = `Conectado como @${access.login}. Solo esta cuenta propietaria puede publicar cambios.`;
        } else {
            lockWhitelistAdminUi();
        }
    }

    async function refreshGistEditorStatus() {
        const status = $('#gist-admin-status');
        status.textContent = 'Comprobando acceso al Gist...';
        try {
            const access = await window.launcherAPI.gistEditorStatus();
            setGistEditorConnected(access);
            status.textContent = access ? 'Acceso de edición verificado.' : 'Conecta la cuenta propietaria para editar y publicar el modpack.';
            if (access) {
                await loadGistEventsIntoEditor();
                await refreshWhitelistCodeGate();
            }
        } catch (error) {
            setGistEditorConnected(null);
            status.textContent = error?.message || String(error);
        }
    }

    async function loadGistEventsIntoEditor() {
        const status = $('#gist-admin-status');
        status.textContent = 'Cargando JSON del Gist...';
        try {
            $('#gist-events-json').value = await window.launcherAPI.gistReadEvents();
            status.textContent = 'JSON cargado. Los cambios se publican solo al pulsar “Publicar cambios”.';
        } catch (error) {
            status.textContent = error?.message || String(error);
        }
    }

    async function refreshWhitelistCodeGate() {
        try {
            state.whitelistAdminCodeConfigured = await window.launcherAPI.gistAdminCodeStatus();
            lockWhitelistAdminUi();
            $('#whitelist-admin-status').textContent = state.whitelistAdminCodeConfigured
                ? 'Whitelist bloqueada. Introduce el código para editarla.'
                : 'Aún no hay un código administrador configurado en este equipo.';
        } catch (error) {
            $('#whitelist-admin-status').textContent = error?.message || String(error);
        }
    }

    function lockWhitelistAdminUi() {
        state.whitelistAdminUnlocked = false;
        state.whitelistAdminCode = '';
        const connected = $('#gist-editor-panel') && !$('#gist-editor-panel').hidden;
        $('#whitelist-admin-editor').hidden = true;
        $('#whitelist-code-setup').hidden = !connected || state.whitelistAdminCodeConfigured;
        $('#whitelist-code-lock').hidden = !connected || !state.whitelistAdminCodeConfigured;
        const codeInput = $('#whitelist-admin-code');
        if (codeInput) codeInput.value = '';
        const newCodeInput = $('#whitelist-new-code');
        if (newCodeInput) newCodeInput.value = '';
        const confirmCodeInput = $('#whitelist-new-code-confirm');
        if (confirmCodeInput) confirmCodeInput.value = '';
        $('#whitelist-change-code-panel').hidden = true;
        $('#whitelist-rotated-code').value = '';
        $('#whitelist-rotated-code-confirm').value = '';
    }

    async function loadLauncherWhitelistIntoEditor() {
        const status = $('#whitelist-admin-status');
        status.textContent = 'Cargando whitelist publicada...';
        try {
            const config = await window.launcherAPI.gistGetLauncherWhitelist();
            $('#launcher-whitelist-enabled').checked = Boolean(config.enabled);
            $('#launcher-whitelist-allowed').value = Array.isArray(config.allowed) ? config.allowed.join('\n') : '';
            status.textContent = config.enabled
                ? `${config.allowed.length} entradas permitidas. La whitelist está activa.`
                : 'La whitelist está desactivada; todas las instancias son visibles.';
        } catch (error) {
            status.textContent = error?.message || String(error);
        }
    }

    function initGistEditorHandlers() {
        const gistJson = $('#gist-events-json');
        gistJson?.addEventListener('focus', () => expandGistJsonEditor(true));
        $('#gist-json-expand')?.addEventListener('click', () => {
            const expanded = !$('#settings-modal').classList.contains('json-editor-expanded');
            expandGistJsonEditor(expanded);
            if (expanded) gistJson?.focus({ preventScroll: true });
        });

        $('#gist-connect-btn')?.addEventListener('click', async () => {
            const tokenInput = $('#gist-admin-token');
            const token = tokenInput.value;
            if (!token.trim()) {
                $('#gist-admin-status').textContent = 'Pega primero el token de GitHub.';
                return;
            }
            const button = $('#gist-connect-btn');
            button.disabled = true;
            button.textContent = 'Verificando...';
            $('#gist-admin-status').textContent = 'Verificando el propietario y el permiso de edición...';
            try {
                const access = await window.launcherAPI.gistConnect(token);
                setGistEditorConnected(access);
                $('#gist-admin-status').textContent = 'Token guardado de forma segura.';
                await loadGistEventsIntoEditor();
                await refreshWhitelistCodeGate();
            } catch (error) {
                $('#gist-admin-status').textContent = error?.message || String(error);
            } finally {
                tokenInput.value = '';
                button.disabled = false;
                button.textContent = 'Conectar cuenta propietaria';
            }
        });

        $('#gist-load-btn')?.addEventListener('click', loadGistEventsIntoEditor);

        $('#gist-publish-btn')?.addEventListener('click', async () => {
            const content = $('#gist-events-json').value;
            if (!confirm('¿Publicar estos cambios en el Gist de eventos? Se actualizará el manifiesto que reciben todos los launchers.')) return;
            const button = $('#gist-publish-btn');
            button.disabled = true;
            $('#gist-admin-status').textContent = 'Validando y publicando cambios...';
            try {
                const access = await window.launcherAPI.gistPublishEvents(content);
                setGistEditorConnected(access);
                $('#gist-admin-status').textContent = 'Cambios publicados correctamente. Actualizando la lista de eventos...';
                await loadEvents();
                $('#gist-admin-status').textContent = 'Cambios publicados correctamente y lista de eventos actualizada.';
            } catch (error) {
                $('#gist-admin-status').textContent = error?.message || String(error);
            } finally {
                button.disabled = false;
            }
        });

        $('#gist-disconnect-btn')?.addEventListener('click', async () => {
            try {
                await window.launcherAPI.gistDisconnect();
                $('#gist-events-json').value = '';
                setGistEditorConnected(null);
                $('#gist-admin-status').textContent = 'Token eliminado de este equipo. Revoca el token en GitHub si ya no lo necesitas.';
            } catch (error) {
                $('#gist-admin-status').textContent = error?.message || String(error);
            }
        });

        $('#whitelist-create-code-btn')?.addEventListener('click', async () => {
            const code = $('#whitelist-new-code').value;
            const confirmation = $('#whitelist-new-code-confirm').value;
            if (code !== confirmation) {
                $('#whitelist-admin-status').textContent = 'Los códigos no coinciden.';
                return;
            }
            try {
                await window.launcherAPI.gistSetAdminCode(code);
                $('#whitelist-new-code').value = '';
                $('#whitelist-new-code-confirm').value = '';
                state.whitelistAdminCodeConfigured = true;
                lockWhitelistAdminUi();
                $('#whitelist-admin-status').textContent = 'Código creado y guardado en el almacén seguro de este equipo. Vuelve a escribirlo para desbloquear.';
            } catch (error) {
                $('#whitelist-admin-status').textContent = error?.message || String(error);
            }
        });

        $('#whitelist-unlock-btn')?.addEventListener('click', async () => {
            const code = $('#whitelist-admin-code').value;
            try {
                await window.launcherAPI.gistVerifyAdminCode(code);
                state.whitelistAdminCode = code;
                state.whitelistAdminUnlocked = true;
                $('#whitelist-admin-code').value = '';
                $('#whitelist-code-lock').hidden = true;
                $('#whitelist-admin-editor').hidden = false;
                await loadLauncherWhitelistIntoEditor();
            } catch (error) {
                $('#whitelist-admin-status').textContent = error?.message || String(error);
                $('#whitelist-admin-code').value = '';
            }
        });

        $('#whitelist-reload-btn')?.addEventListener('click', loadLauncherWhitelistIntoEditor);

        $('#whitelist-save-btn')?.addEventListener('click', async () => {
            if (!state.whitelistAdminUnlocked || !state.whitelistAdminCode) {
                lockWhitelistAdminUi();
                $('#whitelist-admin-status').textContent = 'Desbloquea la whitelist con el código administrador antes de guardar.';
                return;
            }
            const allowed = $('#launcher-whitelist-allowed').value
                .split(/\r?\n/)
                .map(value => value.trim())
                .filter(Boolean);
            if (!confirm('¿Publicar esta whitelist? Los usuarios fuera de la lista dejarán de ver las instancias del launcher.')) return;
            const button = $('#whitelist-save-btn');
            button.disabled = true;
            try {
                await window.launcherAPI.gistPublishLauncherWhitelist({
                    adminCode: state.whitelistAdminCode,
                    enabled: $('#launcher-whitelist-enabled').checked,
                    allowed,
                });
                $('#whitelist-admin-status').textContent = 'Whitelist publicada. Actualizando el catálogo...';
                await loadEvents();
                $('#whitelist-admin-status').textContent = 'Whitelist publicada y catálogo actualizado.';
            } catch (error) {
                $('#whitelist-admin-status').textContent = error?.message || String(error);
            } finally {
                button.disabled = false;
            }
        });

        $('#whitelist-lock-btn')?.addEventListener('click', () => {
            lockWhitelistAdminUi();
            $('#whitelist-admin-status').textContent = 'Whitelist bloqueada.';
        });

        $('#whitelist-show-change-code-btn')?.addEventListener('click', () => {
            $('#whitelist-change-code-panel').hidden = false;
            $('#whitelist-rotated-code').focus();
        });

        $('#whitelist-cancel-change-code-btn')?.addEventListener('click', () => {
            $('#whitelist-change-code-panel').hidden = true;
            $('#whitelist-rotated-code').value = '';
            $('#whitelist-rotated-code-confirm').value = '';
        });

        $('#whitelist-change-code-btn')?.addEventListener('click', async () => {
            const nextCode = $('#whitelist-rotated-code').value;
            const confirmation = $('#whitelist-rotated-code-confirm').value;
            if (nextCode !== confirmation) {
                $('#whitelist-admin-status').textContent = 'Los códigos no coinciden.';
                return;
            }
            if (!state.whitelistAdminUnlocked || !state.whitelistAdminCode) {
                lockWhitelistAdminUi();
                $('#whitelist-admin-status').textContent = 'Desbloquea la whitelist con el código actual antes de cambiarlo.';
                return;
            }
            const button = $('#whitelist-change-code-btn');
            button.disabled = true;
            try {
                await window.launcherAPI.gistSetAdminCode(nextCode, state.whitelistAdminCode);
                state.whitelistAdminCode = nextCode;
                $('#whitelist-change-code-panel').hidden = true;
                $('#whitelist-rotated-code').value = '';
                $('#whitelist-rotated-code-confirm').value = '';
                $('#whitelist-admin-status').textContent = 'Código administrador cambiado en este equipo.';
            } catch (error) {
                $('#whitelist-admin-status').textContent = error?.message || String(error);
            } finally {
                button.disabled = false;
            }
        });
    }

    /* ═══════════════════════════════════════════════════════════════════
       LAUNCH CARD / GAME
       ═══════════════════════════════════════════════════════════════════ */
    function updateLaunchCardIdle() {
        const card = $('#launch-card');
        const ev = state.selectedInstance;
        if (!card) return;

        card.dataset.state = 'idle';
        $('#launch-title').textContent = ev?.nombre_evento || 'Selecciona una instancia';
        $('#launch-status').textContent = ev ? 'Listo para jugar' : 'Sin instancia';
        $('#launch-progress-wrap').hidden = true;
        $('#launch-progress-fill').style.width = '0%';

        const thumb = $('#launch-thumb');
        const thumbSrc = ev?.imagen_fondo || ev?.icono || ev?.logo;
        thumb.style.backgroundImage = thumbSrc ? `url("${thumbSrc}")` : 'none';

        const btn = $('#launch-play-btn');
        btn.disabled = !ev;
        btn.textContent = 'PLAY';
    }

    function updateLaunchCardDownloading(pct, etaText) {
        const card = $('#launch-card');
        card.dataset.state = 'downloading';

        $('#launch-progress-wrap').hidden = false;
        $('#launch-progress-fill').style.width = pct + '%';
        $('#launch-progress-pct').textContent = pct + '%';
        $('#launch-progress-eta').textContent = etaText || '';

        const btn = $('#launch-play-btn');
        btn.disabled = true;
        btn.textContent = pct + '%';
    }

    function updateLaunchCardLaunching() {
        const card = $('#launch-card');
        card.dataset.state = 'launching';
        $('#launch-status').textContent = 'Iniciando cliente...';
        $('#launch-progress-wrap').hidden = true;

        const btn = $('#launch-play-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>';
    }

    function flashLaunchStatus(text, kind = 'info') {
        const status = $('#launch-status');
        if (!status) return;
        const prev = status.textContent;
        status.textContent = text;
        status.style.color = kind === 'error' ? '#f87171' : kind === 'success' ? '#4ade80' : '';
        setTimeout(() => {
            if (status.textContent !== text) return;
            status.textContent = prev;
            status.style.color = '';
        }, 2500);
    }

    function initLaunchHandlers() {
        $('#launch-play-btn')?.addEventListener('click', handleLaunch);
    }

    let launchInProgress = false;
    let syncingInstanceId = null;
    async function handleLaunch() {
        if (launchInProgress || state.activeGameInstanceId) return;
        launchInProgress = true;
        try {
        if (!state.creds) {
            flashLaunchStatus('Inicia sesión primero', 'error');
            return;
        }
        if (!state.selectedInstance) {
            flashLaunchStatus('Selecciona una instancia', 'error');
            return;
        }

        let selected = state.selectedInstance;
        if (selected.managed_pack) {
            try { selected = await window.launcherCommunity.resolveEvent(selected); }
            catch (error) { flashLaunchStatus(error.message, 'error'); return; }
        }
        const access = selected.managed_pack ? { allowed: true } : await safeCall(
            () => window.launcherAPI.checkInstanceWhitelist(
                selected.id,
                state.creds.uuid,
                state.creds.username || state.creds.name
            ),
            { allowed: false, reason: 'No se pudo verificar el acceso al evento. Inténtalo de nuevo.' }
        );

        if (!access?.allowed) {
            flashLaunchStatus(access?.reason || 'No estás en la whitelist', 'error');
            return;
        }

        if (selected.url_modpack) {
            state.socialPreparingInstanceId = selected.id;
            sendSocialHeartbeat();
            const playButton = $('#launch-play-btn');
            playButton.disabled = true;
            playButton.textContent = '0%';
            $('#launch-card').dataset.state = 'downloading';
            $('#launch-progress-wrap').hidden = false;
            $('#launch-status').textContent = 'Preparando descarga del evento...';
            try {
                syncingInstanceId = selected.id;
                const downloadLimitKbps = Number.parseInt(localStorage.getItem('migajasDownloadLimitKbps') || '0', 10) || 0;
                const synced = await window.launcherAPI.syncInstance(selected, downloadLimitKbps);
                if (!synced?.success) throw new Error(synced?.error || 'No se pudo instalar el modpack.');
                if (synced.runtime) selected = { ...selected, ...synced.runtime };
                state.selectedInstance = selected;
                void refreshLocalInstances();
            } catch (error) {
                $('#launch-card').dataset.state = 'error';
                $('#launch-status').textContent = error?.message || String(error);
                playButton.disabled = false;
                playButton.textContent = 'PLAY';
                return;
            } finally {
                syncingInstanceId = null;
            }
        }

        updateLaunchCardLaunching();
        const ramMax = parseInt(localStorage.getItem('migajasRamMax') || '4096', 10);
        const jvmArgs = localStorage.getItem('migajasJvmArgs') || '';
        const fullscreen = localStorage.getItem('migajasFullscreen') === '1';

        let launchResult;
        try {
            launchResult = await window.launcherAPI.lanzarJuego({
                auth: state.creds,
                ram: Math.round(ramMax / 1024) + 'G',
                config: selected,
                esVanilla: false,
                resolucion: fullscreen ? null : { width: 1280, height: 720 },
                jvmArgs
            });
        } catch (error) {
            launchResult = { started: false, error: error?.message || String(error) || 'No se pudo iniciar el juego.' };
        }
        if (launchResult?.started === false) {
            $('#launch-card').dataset.state = 'error';
            $('#launch-status').textContent = launchResult.error || 'No se pudo iniciar el juego.';
            const button = $('#launch-play-btn');
            button.disabled = false;
            button.textContent = 'PLAY';
        } else if (launchResult?.started && ['launching', 'downloading'].includes($('#launch-card').dataset.state)) {
            state.activeGameInstanceId = selected.id;
            showGameProcessStatus(selected.id, 'STARTING_JVM');
        }
        } finally {
            launchInProgress = false;
            state.socialPreparingInstanceId = null;
            sendSocialHeartbeat();
        }
    }

    function showGameProcessStatus(instanceId, gameState) {
        if (String(instanceId) !== String(state.selectedInstance?.id)) return;
        if (gameState === 'STARTING_JVM' || gameState === 'RUNNING') {
            $('#launch-card').dataset.state = 'running';
            $('#launch-progress-wrap').hidden = true;
            $('#launch-status').textContent = gameState === 'RUNNING' ? 'Minecraft en ejecución' : 'Abriendo Minecraft…';
            $('#launch-play-btn').disabled = true;
            $('#launch-play-btn').textContent = 'EN EJECUCIÓN';
        } else if (gameState === 'STOPPED') {
            updateLaunchCardIdle();
        } else if (gameState === 'CRASHED') {
            $('#launch-card').dataset.state = 'error';
            $('#launch-progress-wrap').hidden = true;
            $('#launch-status').textContent = 'Minecraft se cerró por un error. La descarga está guardada; revisa el registro de la instancia.';
            $('#launch-play-btn').disabled = false;
            $('#launch-play-btn').textContent = 'PLAY';
        }
    }

    /* ═══════════════════════════════════════════════════════════════════
       TAURI EVENTS
       ═══════════════════════════════════════════════════════════════════ */
    function wireTauriEvents() {
        const api = window.launcherAPI;
        if (!api) return;

        api.onProgreso?.((p) => {
            if (!p || !p.total) return;

            const pct = Math.round((p.task / p.total) * 100);
            const now = Date.now();
            let etaText = '';

            if (state.lastProgress.time && state.lastProgress.task < p.task) {
                const dt = (now - state.lastProgress.time) / 1000;
                const dtask = p.task - state.lastProgress.task;
                if (dt > 0.3 && dtask > 0) {
                    const speed = dtask / dt;
                    const remaining = (p.total - p.task) / speed;
                    if (isFinite(remaining) && remaining > 0 && remaining < 3600) {
                        etaText = '~' + Math.ceil(remaining) + 's restantes';
                    }
                }
            }
            state.lastProgress = { task: p.task, time: now };

            updateLaunchCardDownloading(pct, etaText);

            let msg = 'Descargando...';
            if (p.type === 'assets') msg = 'Verificando recursos...';
            else if (p.type === 'natives') msg = 'Extrayendo nativas...';
            $('#launch-status').textContent = msg;
        });

        api.onSyncProgress?.((p) => {
            if (!p || p.instanceId !== state.selectedInstance?.id || p.instanceId !== syncingInstanceId) return;
            const pct = p.bytesTotal > 0
                ? Math.min(99, Math.floor((p.bytesProcessed / p.bytesTotal) * 100))
                : (p.filesProcessed >= p.filesTotal ? 100 : 0);
            updateLaunchCardDownloading(pct, '');
            $('#launch-status').textContent = p.currentFile || 'Descargando archivos del evento...';
        });

        api.onInstallProgress?.((p) => {
            if (!p || p.instanceId !== state.selectedInstance?.id || !launchInProgress || state.activeGameInstanceId === p.instanceId) return;
            const card = $('#launch-card');
            card.dataset.state = 'downloading';
            $('#launch-progress-wrap').hidden = true;
            $('#launch-status').textContent = p.status || 'Preparando Minecraft...';
            const button = $('#launch-play-btn');
            button.disabled = true;
            button.innerHTML = '<span class="spinner"></span>';
        });

        api.onGameStateChanged?.((event) => {
            if (!event?.instanceId) return;
            const gameState = String(event.state || '').toUpperCase();
            if (gameState === 'STARTING_JVM' || gameState === 'RUNNING') {
                state.activeGameInstanceId = event.instanceId;
            }
            if (gameState === 'STOPPED' || gameState === 'CRASHED') {
                if (state.activeGameInstanceId === event.instanceId) {
                    state.activeGameInstanceId = null;
                    state.socialLastActivityAt = Date.now();
                }
            }
            if (state.socialHeartbeat && socialConfig().url) {
                sendSocialHeartbeat();
            }
            showGameProcessStatus(event.instanceId, gameState);
        });

        api.onErrorLanzamiento?.((data) => {
            const card = $('#launch-card');
            card.dataset.state = 'error';
            $('#launch-status').textContent = data?.mensaje || 'Error al lanzar';
            const btn = $('#launch-play-btn');
            btn.disabled = false;
            btn.textContent = 'PLAY';
            setTimeout(updateLaunchCardIdle, 4000);
        });

        api.onResetUi?.(() => updateLaunchCardIdle());
    }

    /* ═══════════════════════════════════════════════════════════════════
       SERVER STATUS
       ═══════════════════════════════════════════════════════════════════ */
    async function updateServerStatus(ip) {
        const pill = $('#server-status-pill');
        const text = $('#server-status-text');

        pill.className = 'server-status-pill offline';
        text.textContent = 'Comprobando...';

        if (!ip) {
            text.textContent = 'Sin servidor';
            return;
        }

        const [host, portStr] = ip.split(':');
        const port = portStr ? parseInt(portStr, 10) : 25565;

        const result = await safeCall(
            () => window.launcherAPI.serverPing?.(host, port),
            { success: false }
        );

        if (result?.success) {
            pill.className = 'server-status-pill online';
            const players = result.players ? ` · ${result.players.online}/${result.players.max}` : '';
            const ping = result.latencyMs ? ` · ${result.latencyMs}ms` : '';
            text.textContent = 'En línea' + players + ping;
        } else {
            text.textContent = 'Desconectado';
        }
    }

    /* ═══════════════════════════════════════════════════════════════════
       PARTICLES
       ═══════════════════════════════════════════════════════════════════ */
    function initParticles() {
        const canvas = $('#particles-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        let particles = [];

        const resize = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        };
        resize();
        window.addEventListener('resize', resize);

        class Particle {
            constructor() { this.reset(); }
            reset() {
                this.x = Math.random() * canvas.width;
                this.y = Math.random() * canvas.height;
                this.size = Math.random() * 1.8 + 0.5;
                this.vx = (Math.random() - 0.5) * 0.25;
                this.vy = (Math.random() - 0.5) * 0.25;
                this.opacity = Math.random() * 0.5 + 0.2;
                this.fade = Math.random() * 0.004 + 0.0015;
            }
            update() {
                this.x += this.vx;
                this.y += this.vy;
                this.opacity -= this.fade;
                if (this.opacity <= 0 || this.x < 0 || this.x > canvas.width ||
                    this.y < 0 || this.y > canvas.height) this.reset();
            }
            draw() {
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(255,255,255,${this.opacity})`;
                ctx.fill();
            }
        }

        const count = Math.min(90, Math.floor((canvas.width * canvas.height) / 18000));
        for (let i = 0; i < count; i++) particles.push(new Particle());

        (function loop() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            particles.forEach(p => { p.update(); p.draw(); });
            requestAnimationFrame(loop);
        })();
    }
