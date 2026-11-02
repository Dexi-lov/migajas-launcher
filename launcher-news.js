(function (root) {
    'use strict';
    const versionPattern = /^\d+\.\d+\.\d+$/;
    function compareVersions(left, right) {
        const a = String(left).split('.').map(Number), b = String(right).split('.').map(Number);
        for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1; }
        return 0;
    }
    function selectReleases(releases, previous, current) {
        if (!versionPattern.test(current)) return [];
        return releases.filter(entry => versionPattern.test(entry.version)
            && compareVersions(entry.version, current) <= 0
            && (previous && versionPattern.test(previous) ? compareVersions(entry.version, previous) > 0 : entry.version === current))
            .sort((a, b) => compareVersions(b.version, a.version));
    }
    function releaseFromText(version, notes) {
        const lines = String(notes || '').slice(0, 16000).split(/\r?\n/).filter(line => !/^\s*#/.test(line))
            .map(line => line.replace(/^\s*[-*]\s+/, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*_]/g, '').trim()).filter(Boolean);
        return { version, summary: lines.shift() || 'Estas son las novedades de esta versión.', changes: lines };
    }
    const api = { compareVersions, selectReleases, releaseFromText };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
    let dataPromise, showing = false, returnFocus;
    const storageKey = 'migajasLastAnnouncedVersion';
    const welcomeKey = 'migajasEraWelcomeV1';
    const node = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
    const version = () => root.MIGAJAS_SOCIAL_CONFIG?.clientVersion || '';
    function data() {
        if (!dataPromise) dataPromise = fetch('release-notes.json').then(response => {
            if (!response.ok) throw new Error('No se pudieron leer las novedades.');
            return response.json();
        }).catch(error => { dataPromise = null; throw error; });
        return dataPromise;
    }
    function initialize() {
        if (document.getElementById('migui-news-modal')) return;
        const overlay = node('div', undefined, 'modal-overlay'); overlay.id = 'migui-news-modal'; overlay.dataset.modal = '';
        const card = node('section', undefined, 'modal migui-news-modal');
        card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'migui-news-title');
        const header = node('header', undefined, 'migui-news-header');
        const pigeon = document.querySelector('#migui-avatar svg')?.cloneNode(true);
        if (pigeon) { pigeon.classList.add('migui-news-pigeon'); header.append(pigeon); }
        const title = node('div'); title.append(node('span', 'Migui te cuenta', 'migui-news-caption'));
        const h2 = node('h2', '¡Tenemos novedades!'); h2.id = 'migui-news-title'; title.append(h2); header.append(title);
        const content = node('div', undefined, 'migui-news-content'); content.id = 'migui-news-content'; content.tabIndex = 0;
        const footer = node('footer', undefined, 'migui-news-actions');
        for (const [label, className] of [['Ver después', 'btn-ghost'], ['¡Entendido, Migui!', 'btn-primary-red']]) {
            const button = node('button', label, className); button.type = 'button';
            button.addEventListener('click', () => {
                closeModal(overlay.id); showing = false;
                const rect=returnFocus?.getBoundingClientRect?.();
                const target=rect&&rect.right>0&&rect.bottom>0&&rect.left<innerWidth&&rect.top<innerHeight?returnFocus:document.getElementById('sidebar-avatar-btn');
                target?.focus({ preventScroll: true });
            });
            footer.append(button);
        }
        card.append(header, content, footer); overlay.append(card); document.body.append(overlay);
        document.getElementById('migui-news-open')?.addEventListener('click', () => { closeDrawer(); api.open().catch(console.warn); });
    }
    api.open = async function (previous) {
        returnFocus=document.activeElement;
        initialize(); const current = version(); const history = await data();
        let entries = previous === undefined
            ? history.releases.filter(entry => entry.version === current)
            : selectReleases(history.releases, previous, current);
        let published;
        try {
            const pending = JSON.parse(localStorage.getItem('migajasPendingReleaseNotes') || 'null');
            if (pending?.version === current && pending.notes) {
                localStorage.setItem('migajasLatestNewsText', JSON.stringify(pending)); localStorage.removeItem('migajasPendingReleaseNotes');
            }
            const saved = JSON.parse(localStorage.getItem('migajasLatestNewsText') || 'null');
            if (saved?.version === current && saved.notes) published = releaseFromText(current, saved.notes);
        } catch {}
        if (!published && root.MIGAJAS_SOCIAL_CONFIG?.communityUrl) {
            try {
                const response = await fetch(new URL('/updates/current', root.MIGAJAS_SOCIAL_CONFIG.communityUrl), { signal: AbortSignal.timeout(2500) });
                if (response.ok && response.status !== 204) {
                    const currentNotes = await response.json();
                    if (currentNotes.version === current && currentNotes.notes) {
                        localStorage.setItem('migajasLatestNewsText', JSON.stringify(currentNotes));
                        published = releaseFromText(current, currentNotes.notes);
                    }
                }
            } catch {}
        }
        if (published) entries = [published, ...entries.filter(entry => entry.version !== current)];
        document.getElementById('migui-news-title').textContent = '¡Tenemos novedades!';
        const content = document.getElementById('migui-news-content'); content.replaceChildren();
        content.append(node('p', previous ? 'Estas son las novedades desde tu última visita.' : 'Te cuento qué trae esta versión del launcher.', 'migui-news-intro'));
        for (const entry of entries) {
            const section = node('section', undefined, 'migui-news-release');
            section.append(node('h3', 'Versión ' + entry.version), node('p', entry.summary));
            for (const [key, label] of [['new', 'Cosas nuevas'], ['improved', 'Más cómodo para ti'], ['fixed', 'Problemas que arreglamos'], ['changes', 'Lo que cambió']]) {
                if (!entry[key]?.length) continue;
                section.append(node('h4', label)); const list = node('ul');
                for (const change of entry[key]) list.append(node('li', change)); section.append(list);
            }
            content.append(section);
        }
        if (!entries.length) content.append(node('p', 'Esta versión no incluye un resumen de novedades. Puedes consultar al equipo en Discord.'));
        closeDrawer(); openModal('migui-news-modal'); content.scrollTop = 0; showing = true;
        localStorage.setItem(storageKey, current);
        document.querySelector('#migui-news-modal footer button:last-child').focus({ preventScroll: true });
    };
    api.openWelcome = async function () {
        returnFocus = document.activeElement;
        initialize();
        const welcome = (await data()).eraWelcome;
        if (!welcome) return api.open();
        document.getElementById('migui-news-title').textContent = welcome.title;
        const content = document.getElementById('migui-news-content'); content.replaceChildren();
        content.append(node('p', welcome.summary, 'migui-news-intro'));
        for (const item of welcome.sections) {
            const section = node('section', undefined, 'migui-news-release');
            section.append(node('h3', item.title));
            const list = node('ul');
            for (const text of item.items) list.append(node('li', text));
            section.append(list); content.append(section);
        }
        content.append(node('p', welcome.closing));
        closeDrawer(); openModal('migui-news-modal'); content.scrollTop = 0; showing = true;
        localStorage.setItem(welcomeKey, '1'); localStorage.setItem(storageKey, version());
        document.querySelector('#migui-news-modal footer button:last-child').focus({preventScroll:true});
    };
    api.onLogin = async function () {
        const current = version(), previous = localStorage.getItem(storageKey);
        if (!versionPattern.test(current) || showing) return;
        if (localStorage.getItem(welcomeKey) !== '1') {
            if (typeof state !== 'undefined' && state.tutorialStep) return;
            if (document.querySelector('.modal-overlay.open')) return;
            await api.openWelcome(); return;
        }
        if (previous === current) return;
        if (!previous && localStorage.getItem('migajasTutorialSeenV2') !== '1') { localStorage.setItem(storageKey, current); return; }
        if (previous && compareVersions(current, previous) <= 0) return;
        if (typeof state !== 'undefined' && state.tutorialStep) return;
        if (document.querySelector('.modal-overlay.open')) return;
        await api.open(previous || '');
    };
    root.MigajasNews = api;
    document.addEventListener('DOMContentLoaded', initialize);
    document.addEventListener('migajas-tutorial-ended', () => { if(localStorage.getItem(welcomeKey)!=='1') api.onLogin().catch(console.warn); });
})(typeof window !== 'undefined' ? window : globalThis);
