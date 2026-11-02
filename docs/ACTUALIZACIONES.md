# Actualizaciones automáticas de Migajas Launcher

Este documento explica cómo comprueba, descarga, verifica y publica actualizaciones la versión Tauri 2 del launcher.

**Transición del lanzamiento 1.2.14:** se renovó la clave de firma porque la privada anterior no estaba disponible. Quienes tengan los instaladores de prueba anteriores deben instalar esta versión manualmente una vez. Las siguientes actualizaciones utilizarán la clave nueva. Consulta [la ubicación y copia de seguridad de la clave](CLAVE-DE-FIRMA.md).

Desde 1.2.14 también existe un panel exclusivo para **Programador** y ElDexs, con publicación de instaladores firmados y limpieza automática de la versión anterior. Consulta [Publicar desde el launcher](PUBLICAR-DESDE-EL-LAUNCHER.md). El canal de Cloudflare consulta las publicaciones del panel y mantiene compatibilidad con GitHub.

## Qué ocurre en el equipo del usuario

1. Al iniciar, si **Auto-actualizar launcher** está habilitado, la aplicación espera unos segundos y consulta el canal de Cloudflare, que compara las publicaciones del panel y de GitHub. Las versiones anteriores a 1.2.14 consultan únicamente GitHub.
2. Si no hay una versión superior, informa que el launcher está actualizado. También se puede comprobar manualmente en **Configuración → Actualizaciones del launcher → Buscar actualizaciones**.
3. Si hay una versión superior, muestra su número y las notas. La persona confirma si quiere instalarla.
4. Tauri descarga el paquete NSIS de Windows y valida su firma criptográfica con la clave pública integrada en `src-tauri/tauri.conf.json`.
5. Si la firma es válida, abre el instalador en modo pasivo. El launcher se cierra mientras se instala la nueva versión. La descarga no borra las instancias ni los datos de Minecraft.

La opción **Auto-actualizar launcher** controla la comprobación al iniciar. Al estar desactivada, todavía se puede usar el botón de comprobación manual.

## Qué ocurre al publicar una versión

El workflow `.github/workflows/release.yml` se activa cuando se sube una etiqueta Git con formato `vX.Y.Z`. En Windows compila Tauri, crea el instalador NSIS y los artefactos firmados, y publica en la release:

- El instalador normal para instalar manualmente.
- El paquete y la firma que consume el updater de Tauri.
- `latest.json`, el manifiesto que indica la versión, URL y firma de la actualización.

El endpoint principal configurado en `src-tauri/tauri.conf.json` apunta al canal de Cloudflare; GitHub se conserva como alternativa. Las releases deben ser públicas para que los launchers puedan leerlas sin iniciar sesión en GitHub. El flujo de actualización configurado aquí compila Windows x64 con NSIS.

## Preparación necesaria en GitHub

Tauri exige firmar los paquetes. La clave privada no está en el repositorio; la clave pública sí, porque se usa para verificar que la descarga pertenece al proyecto.

En este equipo se generó el par de claves del updater. La clave privada se encuentra fuera del repositorio en una carpeta visible del Escritorio:

```text
%USERPROFILE%\Desktop\MigajasLauncherSigning\updater.key
```

No compartas ese archivo, no lo subas a Git y conserva una copia de respaldo segura. El archivo está fuera del proyecto y sus permisos locales se limitaron a tu cuenta de Windows y al sistema. Si se pierde, las instalaciones que confían en la clave pública actual no podrán aceptar paquetes firmados con otra clave; será necesario distribuir manualmente una instalación puente con la nueva clave.

Para cargar la clave privada como secreto del repositorio, con GitHub CLI instalado y autenticado con permiso para administrar Actions secrets, ejecuta PowerShell:

```powershell
Get-Content -Raw "$env:USERPROFILE\Desktop\MigajasLauncherSigning\updater.key" | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo Dexi-lov/migajas-launcher
```

También puedes crear el secreto desde GitHub: abre el repositorio, entra en **Settings → Secrets and variables → Actions → New repository secret**, pon `TAURI_SIGNING_PRIVATE_KEY` como nombre y pega el contenido de `%USERPROFILE%\Desktop\MigajasLauncherSigning\updater.key` como valor. El valor no debe aparecer en commits, issues ni mensajes.

La clave creada no tiene contraseña, así que no se necesita configurar `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Si se reemplaza por una clave protegida con contraseña, hay que guardar también esa contraseña como secreto de GitHub con ese nombre.

El workflow detiene la publicación con un mensaje claro si falta `TAURI_SIGNING_PRIVATE_KEY`. El token `GITHUB_TOKEN` de Actions se genera automáticamente y el permiso `contents: write` del workflow permite subir los artefactos y manifiesto.

## Publicar una actualización

El comando de publicación está automatizado en `scripts/publicar.js`. Después de integrar y subir los cambios a `main`, el responsable de la versión ejecuta:

```powershell
npm run publicar
```

Por defecto aumenta patch. También acepta `npm run publicar -- minor` o `npm run publicar -- major`. Para simularlo antes, sin modificar ni subir nada, usa `npm run publicar -- --dry-run`.

El script se asegura de que el directorio esté limpio, estés en `main`, la rama local coincida con `origin/main`, todas las versiones sean iguales y el tag nuevo no esté usado. Luego actualiza `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` y `src-tauri/tauri.conf.json`; crea un commit de versión, una etiqueta anotada y los sube juntos. No agrega cambios del launcher automáticamente, para no publicar archivos accidentales. Si el push se interrumpe, repetir el mismo comando reintenta esa publicación en lugar de crear otro incremento.

Al recibir el tag, GitHub Actions compila, firma y publica el instalador y `latest.json`. Revisa el resultado en **Actions → Publicar launcher Tauri y actualizador** y luego confirma que la release tenga el instalador y el manifiesto en `https://github.com/Dexi-lov/migajas-launcher/releases/latest/download/latest.json`.

La versión publicada debe ser SemVer superior a la que ya tiene el usuario. No reutilices un número publicado.

## Instalación puente para la migración actual

Los instaladores Tauri anteriores a `1.1.6` no incluyen el plugin, la clave pública ni la lógica de actualización. No pueden descubrir una actualización por sí mismos. Por eso, la primera versión que se publique con este sistema es una instalación puente: los usuarios actuales deben instalar **una vez** el instalador Tauri `1.1.6` desde la release o el canal actual de distribución. Desde esa instalación en adelante, las versiones superiores se podrán recibir desde el propio launcher sin volver a descargar el instalador desde Discord.

## Diagnóstico rápido

- **La acción falla indicando que falta la clave privada:** configura el secreto `TAURI_SIGNING_PRIVATE_KEY` en GitHub Actions.
- **La comprobación devuelve 404 o no encuentra release:** comprueba que el repositorio sea público, que exista una release publicada y que tenga `latest.json`.
- **No aparece actualización:** la versión del manifiesto debe ser SemVer superior a la instalada y debe coincidir con los archivos de versión del proyecto.
- **La descarga se rechaza por firma:** no cambies la clave pública para resolverlo. Comprueba que Actions firmó el artefacto con la clave privada asociada a la clave pública configurada.
- **El workflow no arranca:** las etiquetas deben tener el formato `vX.Y.Z` y llegar al repositorio remoto mediante `git push origin <etiqueta>`.

Este flujo de publicación es para Tauri/Windows. El mecanismo histórico `electron-updater` de `main.js` es independiente y no produce actualizaciones para la instalación Tauri.
