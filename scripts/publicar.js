#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const versionFiles = [
  'package.json',
  'package-lock.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'release-notes.json',
];

function fail(message) {
  console.error(`\nNo se publicó la actualización. ${message}`);
  process.exit(1);
}

function git(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error) fail(`No se pudo ejecutar Git: ${result.error.message}`);
  return result;
}

function runGit(args, description) {
  const result = git(args, { stdio: 'inherit' });
  if (result.status !== 0) {
    fail(`${description}. Si se interrumpió la subida, vuelve a ejecutar el mismo comando para reintentar.`);
  }
}

function readJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
  } catch (error) {
    fail(`No se pudo leer ${relativePath}: ${error.message}`);
  }
}

function writeJson(relativePath, value) {
  fs.writeFileSync(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readCargoVersion(relativePath, packageName) {
  const contents = fs.readFileSync(path.join(root, relativePath), 'utf8');
  if (relativePath.endsWith('Cargo.toml')) {
    const expression = /(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m;
    const match = contents.match(expression);
    if (!match) fail(`No se encontró la versión del paquete en ${relativePath}.`);
    return { contents, version: match[2], expression };
  }

  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`(\\[\\[package\\]\\]\\s*\\nname = "${escapedName}"\\s*\\nversion = ")([^"]+)(")`);
  const match = contents.match(expression);
  if (!match) fail(`No se encontró el paquete ${packageName} en ${relativePath}.`);
  return { contents, version: match[2], expression };
}

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) fail(`La versión actual (${version}) no es SemVer estable X.Y.Z.`);
  return match.slice(1).map(Number);
}

function bumpVersion(version, kind) {
  const [major, minor, patch] = parseVersion(version);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function getVersion() {
  const packageJson = readJson('package.json');
  const lockJson = readJson('package-lock.json');
  const tauriJson = readJson('src-tauri/tauri.conf.json');
  const cargoToml = readCargoVersion('src-tauri/Cargo.toml', 'app');
  const cargoLock = readCargoVersion('src-tauri/Cargo.lock', 'app');
  const versions = [
    ['package.json', packageJson.version],
    ['package-lock.json', lockJson.version],
    ['src-tauri/Cargo.toml', cargoToml.version],
    ['src-tauri/Cargo.lock', cargoLock.version],
    ['src-tauri/tauri.conf.json', tauriJson.version],
  ];
  const different = versions.filter(([, value]) => value !== packageJson.version);
  if (different.length) {
    fail(`Las versiones no coinciden. package.json indica ${packageJson.version}; revisa ${different.map(([file, value]) => `${file} (${value})`).join(', ')}.`);
  }
  parseVersion(packageJson.version);
  return packageJson.version;
}

function ensureCleanWorkingTree() {
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  if (status.status !== 0) fail('No se pudo consultar el estado del repositorio.');
  if (status.stdout.trim()) {
    console.error(status.stdout.trim());
    fail('Primero guarda el trabajo: confirma y sube tus cambios a main. El publicador no añadirá archivos por su cuenta para evitar incluir datos personales o archivos accidentales.');
  }
}

function ensureGitIdentity() {
  for (const key of ['user.name', 'user.email']) {
    const result = git(['config', '--get', key]);
    if (result.status !== 0 || !result.stdout.trim()) {
      fail(`Falta configurar ${key}. Configúralo una vez con: git config --global ${key} "Tu nombre o correo".`);
    }
  }
}

function prepareVersion(newVersion) {
  const packageJson = readJson('package.json');
  const lockJson = readJson('package-lock.json');
  const tauriJson = readJson('src-tauri/tauri.conf.json');
  const cargoToml = readCargoVersion('src-tauri/Cargo.toml', 'app');
  const cargoLock = readCargoVersion('src-tauri/Cargo.lock', 'app');

  packageJson.version = newVersion;
  lockJson.version = newVersion;
  if (lockJson.packages?.['']) lockJson.packages[''].version = newVersion;
  tauriJson.version = newVersion;
  writeJson('package.json', packageJson);
  writeJson('package-lock.json', lockJson);
  writeJson('src-tauri/tauri.conf.json', tauriJson);
  fs.writeFileSync(path.join(root, 'src-tauri/Cargo.toml'), cargoToml.contents.replace(cargoToml.expression, `$1${newVersion}$3`), 'utf8');
  fs.writeFileSync(path.join(root, 'src-tauri/Cargo.lock'), cargoLock.contents.replace(cargoLock.expression, `$1${newVersion}$3`), 'utf8');
}

function ensureRemoteMainIsCurrent() {
  const branch = git(['branch', '--show-current']);
  if (branch.status !== 0 || branch.stdout.trim() !== 'main') {
    fail(`Estás en la rama "${branch.stdout.trim() || '(sin rama)'}". Cambia a main antes de publicar.`);
  }
  const remote = git(['remote', 'get-url', 'origin']);
  if (remote.status !== 0 || !remote.stdout.trim()) fail('No existe un remoto Git llamado origin.');
  runGit(['fetch', '--quiet', '--tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], 'No se pudo sincronizar con origin/main');
}

function pushRelease(tag) {
  runGit(
    ['push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}:refs/tags/${tag}`],
    'GitHub rechazó la subida. Revisa tu conexión, permisos para subir a main y permisos para crear etiquetas',
  );
  console.log('\nLa publicación quedó enviada a GitHub Actions.');
  console.log(`Versión: ${tag.slice(1)}`);
  console.log(`Progreso de compilación: https://github.com/Dexi-lov/migajas-launcher/actions/workflows/release.yml`);
  console.log(`Release: https://github.com/Dexi-lov/migajas-launcher/releases/tag/${tag}`);
  console.log('Cuando Actions termine correctamente, el launcher ofrecerá esta versión a sus usuarios.');
}

function remoteTagCommit(output, tag) {
  const records = output.trim().split(/\r?\n/).filter(Boolean).map((line) => line.trim().split(/\s+/));
  const peeled = records.find(([, reference]) => reference === `refs/tags/${tag}^{}`);
  const direct = records.find(([, reference]) => reference === `refs/tags/${tag}`);
  return peeled?.[0] || direct?.[0] || '';
}

function resumeInterruptedRelease(currentVersion, dryRun) {
  const tag = `v${currentVersion}`;
  const localTag = git(['rev-parse', '--verify', `refs/tags/${tag}`]);
  const head = git(['rev-parse', 'HEAD']);
  const subject = git(['log', '-1', '--format=%s']);
  const base = git(['rev-parse', 'origin/main']);
  const ancestor = git(['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
  const ahead = git(['rev-list', '--count', 'origin/main..HEAD']);
  if (head.status !== 0 || base.status !== 0) fail('No se pudo verificar una publicación anterior interrumpida.');
  if (localTag.status !== 0 && subject.stdout.trim() !== `chore(release): ${tag}`) return false;

  const tagCommit = localTag.status === 0 ? git(['rev-list', '-n', '1', tag]) : null;
  if (tagCommit && tagCommit.stdout.trim() !== head.stdout.trim()) {
    fail(`La etiqueta local ${tag} ya existe y no corresponde a una publicación incompleta segura. No se modificó.`);
  }

  const remoteTag = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}*`]);
  if (remoteTag.status !== 0) fail('No se pudo consultar la etiqueta en GitHub.');
  const remoteCommit = remoteTagCommit(remoteTag.stdout, tag);
  if (remoteCommit) {
    if (remoteCommit === head.stdout.trim() && base.stdout.trim() === head.stdout.trim()) {
      console.log(`${tag} ya está publicada en GitHub; no se creó otra versión.`);
      console.log(`Progreso de compilación: https://github.com/Dexi-lov/migajas-launcher/actions/workflows/release.yml`);
      console.log(`Release: https://github.com/Dexi-lov/migajas-launcher/releases/tag/${tag}`);
      return true;
    }
    fail(`La etiqueta ${tag} ya está en GitHub, pero el repositorio no coincide con esta publicación. Revisa Actions antes de continuar.`);
  }

  if (
    subject.stdout.trim() !== `chore(release): ${tag}` ||
    ancestor.status !== 0 ||
    ahead.stdout.trim() !== '1'
  ) {
    if (localTag.status !== 0) return false;
    fail(`La etiqueta local ${tag} ya existe y no corresponde a una publicación incompleta segura. No se modificó.`);
  }
  if (dryRun) {
    console.log(`Publicación incompleta detectada. Al ejecutar sin --dry-run se volverá a subir ${tag}.`);
    return true;
  }

  if (localTag.status !== 0) runGit(['tag', '-a', tag, '-m', `Migajas Launcher ${tag}`], `No se pudo recuperar la etiqueta ${tag}`);
  console.log(`Reintentando la subida de ${tag} sin crear otra versión...`);
  pushRelease(tag);
  return true;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Publicador de Migajas Launcher');
    console.log('Uso: npm run publicar -- [patch|minor|major] [--notas "Resumen para los jugadores"] [--dry-run]');
    console.log('Sin tipo usa patch. El comando requiere main limpio y sincronizado con origin/main.');
    return;
  }
  const notesIndex = args.indexOf('--notas');
  const notes = notesIndex >= 0 ? args[notesIndex + 1]?.trim() : '';
  if (notesIndex >= 0 && (!notes || notes.startsWith('--'))) fail('Escribe las novedades después de --notas, entre comillas.');
  if (notesIndex >= 0) args.splice(notesIndex, 2);
  const dryRun = args.includes('--dry-run');
  const kinds = args.filter((arg) => arg !== '--dry-run');
  if (kinds.length > 1 || (kinds.length === 1 && !['patch', 'minor', 'major'].includes(kinds[0]))) {
    fail('Uso: npm run publicar -- [patch|minor|major] [--notas "Resumen para los jugadores"] [--dry-run]. Si no indicas tipo, se usa patch.');
  }
  const kind = kinds[0] || 'patch';

  ensureCleanWorkingTree();
  ensureGitIdentity();
  ensureRemoteMainIsCurrent();

  const currentVersion = getVersion();
  if (resumeInterruptedRelease(currentVersion, dryRun)) return;

  const head = git(['rev-parse', 'HEAD']);
  const originMain = git(['rev-parse', 'origin/main']);
  if (head.status !== 0 || originMain.status !== 0 || head.stdout.trim() !== originMain.stdout.trim()) {
    fail('main tiene cambios locales o cambios pendientes en GitHub. Integra primero el trabajo del equipo y vuelve a ejecutar el comando.');
  }

  const nextVersion = bumpVersion(currentVersion, kind);
  const tag = `v${nextVersion}`;
  const localTag = git(['show-ref', '--verify', '--quiet', `refs/tags/${tag}`]);
  const remoteTag = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}*`]);
  if (localTag.status === 0 || remoteTag.status !== 0 || remoteTagCommit(remoteTag.stdout, tag)) {
    fail(`La etiqueta ${tag} ya existe o no se pudo consultar en GitHub. No se reutilizan versiones publicadas.`);
  }

  const releaseNotes = readJson('release-notes.json');
  if (notes) releaseNotes.releases = [{version:nextVersion,summary:notes,new:[],improved:[],fixed:[]},...releaseNotes.releases.filter(entry=>entry.version!==nextVersion)];
  try { require('./release-notes.cjs').releaseBody(releaseNotes,nextVersion); } catch(error) { fail(error.message+' Puedes usar --notas "Resumen para los jugadores".'); }
  if (dryRun) {
    console.log(`Vista previa: ${currentVersion} -> ${nextVersion} (${kind}).`);
    console.log('El repositorio está limpio, main coincide con origin/main y la etiqueta no está ocupada.');
    console.log('No se modificaron archivos ni se subió nada.');
    return;
  }

  prepareVersion(nextVersion);
  writeJson('release-notes.json', releaseNotes);
  runGit(['add', ...versionFiles], 'No se pudieron preparar los archivos de publicación');
  const staged = git(['diff', '--cached', '--quiet']);
  if (staged.status !== 1) fail('No se detectaron los cambios de versión que debían confirmarse.');

  runGit(['commit', '-m', `chore(release): ${tag}`], 'No se pudo crear el commit de versión');
  runGit(['tag', '-a', tag, '-m', `Migajas Launcher ${tag}`], `No se pudo crear la etiqueta ${tag}`);
  pushRelease(tag);
}

main();
