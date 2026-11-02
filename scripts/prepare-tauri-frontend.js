const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const frontendDir = path.join(projectRoot, 'frontend');
const assets = ['index.html', 'app.js', 'preload-tauri.js', 'launcher-assistant.js', 'launcher-news.js', 'launcher-publisher.js', 'launcher-news.css', 'release-notes.json', 'community.js', 'mfa-qr.js', 'community.css', 'library.js', 'library.css', 'logo.png'];

fs.mkdirSync(frontendDir, { recursive: true });
require('esbuild').buildSync({ entryPoints: [path.join(projectRoot, 'social-sdk-entry.js')], bundle: true, minify: true, platform: 'browser', outfile: path.join(frontendDir, 'social-client.js') });

for (const asset of assets) {
    fs.copyFileSync(path.join(projectRoot, asset), path.join(frontendDir, asset));
}

const socialEnvPath = path.join(projectRoot, '.env.social');
const socialEnv = {};
if (fs.existsSync(socialEnvPath)) {
    for (const line of fs.readFileSync(socialEnvPath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const separator = trimmed.indexOf('=');
        if (separator < 1) continue;
        const key = trimmed.slice(0, separator).trim();
        const value = trimmed.slice(separator + 1).trim().replace(/^(?:"(.*)"|'(.*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
        socialEnv[key] = value;
    }
}

const publicDefaults = JSON.parse(fs.readFileSync(path.join(projectRoot, 'launcher-public-config.json'), 'utf8'));
const socialUrl = process.env.MIGAJAS_SUPABASE_URL || socialEnv.MIGAJAS_SUPABASE_URL || publicDefaults.url || '';
const socialKey = process.env.MIGAJAS_SUPABASE_PUBLISHABLE_KEY || socialEnv.MIGAJAS_SUPABASE_PUBLISHABLE_KEY || publicDefaults.publishableKey || '';
if (socialUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(socialUrl)) {
    throw new Error('MIGAJAS_SUPABASE_URL debe ser la URL HTTPS del proyecto Supabase.');
}
if (socialKey && !/^(sb_publishable_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]+)$/.test(socialKey)) {
    throw new Error('Usa la clave pública publishable o anon de Supabase; no incluyas una clave secret/service_role.');
}

const communityUrl = process.env.MIGAJAS_COMMUNITY_URL || socialEnv.MIGAJAS_COMMUNITY_URL || publicDefaults.communityUrl || '';
if (communityUrl && !/^https:\/\/[a-z0-9.-]+(?:\/[a-z0-9_-]+)*\/?$/i.test(communityUrl)) throw new Error('MIGAJAS_COMMUNITY_URL debe usar HTTPS.');
const socialConfig = `window.MIGAJAS_SOCIAL_CONFIG = Object.freeze(${JSON.stringify({
    clientVersion: require(path.join(projectRoot, 'package.json')).version,
    url: socialUrl.replace(/\/$/, ''),
    publishableKey: socialKey,
    communityUrl: communityUrl.replace(/\/$/, ''),
})});\n`;
fs.writeFileSync(path.join(frontendDir, 'social-config.js'), socialConfig, 'utf8');
