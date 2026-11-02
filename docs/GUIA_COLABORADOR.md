# Guía del equipo de Migajas Launcher

Esta guía está pensada para alguien que recién empieza a colaborar. El launcher tiene dos partes: la interfaz que ve la persona y el motor que hace el trabajo en Windows.

## 1. Cómo está organizado

| Ruta | Para qué sirve |
| --- | --- |
| `index.html` | Pantallas, estilos y lógica de la interfaz. Es el archivo que se edita para cambiar lo que ve el usuario. |
| `preload-tauri.js` | Puente entre la interfaz JavaScript y los comandos Rust. Si agregas una operación Rust que use la interfaz, normalmente debes exponerla aquí. |
| `src-tauri/src/lib.rs` | Arranque de Tauri, estado compartido y lista de comandos permitidos a la interfaz. |
| `src-tauri/src/auth.rs` | Inicio de sesión Microsoft y perfiles guardados. |
| `src-tauri/src/launch.rs` | Preparación y arranque del juego. |
| `src-tauri/src/sync.rs` | Descarga, reparación y sincronización de archivos de instancias. |
| `src-tauri/src/options.rs` | Opciones del juego y paquetes de recursos. |
| `src-tauri/src/instances.rs` | Whitelist de evento, detección de instancias del launcher y borrado protegido. |
| `src-tauri/src/gist.rs` | Lectura y publicación del catálogo y whitelist del launcher en GitHub Gist. |
| `src-tauri/src/diagnostics.rs` | Análisis de informes de fallos. |
| `src-tauri/src/screenshots.rs` | Lista y operaciones con capturas de pantalla. |
| `src-tauri/src/server_ping.rs` | Consulta de ping y estado de servidores. |
| `src-tauri/src/vault.rs` | Protección temporal de los archivos de mods durante el cierre del launcher. |
| `src-tauri/tauri.conf.json` | Nombre, versión, permisos básicos, recursos, instalador y updater. |
| `scripts/prepare-tauri-frontend.js` | Copia `index.html`, `preload-tauri.js` y recursos al directorio `frontend` antes de ejecutar o compilar Tauri. |
| `.github/workflows/release.yml` | Compilación y publicación automática de una versión cuando se sube una etiqueta `vX.Y.Z`. |
| `docs/` | Guías funcionales y de administración. |

La ruta `frontend/` es una copia generada para Tauri. Edita los archivos raíz y deja que `scripts/prepare-tauri-frontend.js` actualice la copia.

## 2. Preparar el equipo

En Windows instala:

- Git para Windows.
- Node.js 22 o una versión LTS compatible.
- Rust estable. El proyecto declara Rust 1.90 como mínimo.
- Microsoft C++ Build Tools y WebView2 Runtime, que Tauri necesita para compilar y mostrar la aplicación.

Después de clonar el repositorio, abre PowerShell en la carpeta del proyecto y ejecuta:

```powershell
npm ci
npm run tauri:dev
```

`npm ci` instala las dependencias exactas registradas en `package-lock.json`. `npm run tauri:dev` prepara la interfaz y abre el launcher en modo de desarrollo. Para compilar un instalador en este equipo:

```powershell
npm run tauri:build
```

El build firmado necesita la clave privada del updater configurada como `TAURI_SIGNING_PRIVATE_KEY`. El workflow de GitHub Actions la recibe desde los secretos del repositorio; no pongas la clave dentro del código.

## 3. Forma simple de colaborar

1. Actualiza tu copia antes de empezar:

   ```powershell
   git switch main
   git pull origin main
   git switch -c feature/nombre-del-cambio
   ```

2. Edita el código y ejecuta `npm run tauri:dev` para comprobarlo visualmente. Si cambias archivos Rust, Tauri recompila el backend al desarrollar.
3. Guarda cambios en commits pequeños que expliquen qué se hizo:

   ```powershell
   git add index.html src-tauri/src/lib.rs
   git commit -m "Añade descripción del cambio"
   git push -u origin feature/nombre-del-cambio
   ```

   Sustituye la lista de archivos por los que editaste. No uses `git add .` si no sabes qué archivos cambiaron: así evitas subir mundos, archivos descargados, claves o cambios accidentales.
4. Integra la rama en `main` mediante el método que use el equipo (por ejemplo, un Pull Request en GitHub).
5. Publica una versión siguiendo la sección siguiente.

Git necesita saber qué nombre y correo poner en los commits. Se configuran una sola vez:

```powershell
git config --global user.name "Tu nombre"
git config --global user.email "tu-correo@example.com"
```

## 4. Publicar una actualización con un comando

Cuando el cambio ya esté integrado y subido a `main`, abre PowerShell en el proyecto y ejecuta:

```powershell
npm run publicar
```

Ese comando publica el siguiente **patch** (por ejemplo, `1.1.6` pasa a `1.1.7`). El programa:

1. Comprueba que no haya cambios sin guardar, que estés en `main` y que `main` coincida con GitHub.
2. Comprueba que `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock` y `tauri.conf.json` tengan la misma versión.
3. Aumenta la versión, actualiza esos cinco archivos y crea un commit y una etiqueta Git anotada.
4. Sube el commit y la etiqueta juntos a GitHub. La subida atómica evita que quede el tag publicado sin el commit de versión, o al revés.
5. La etiqueta inicia GitHub Actions. Actions compila el instalador Windows, firma el paquete y adjunta el instalador y `latest.json` a la release.
6. El comando muestra enlaces a Actions y a la release para revisar el resultado.

También puedes elegir cuánto aumenta la versión:

```powershell
npm run publicar -- patch
npm run publicar -- minor
npm run publicar -- major
```

`patch` arreglos pequeños (`1.1.6` → `1.1.7`), `minor` funciones nuevas (`1.1.6` → `1.2.0`) y `major` cambios grandes (`1.1.6` → `2.0.0`). Para revisar lo que haría sin cambiar archivos ni subir nada:

```powershell
npm run publicar -- --dry-run
```

Si se corta la conexión durante el push, puedes repetir el mismo comando: el script reconoce el commit/tag de release que quedó pendiente y vuelve a intentar la subida sin aumentar otra vez la versión.

### Lo que se configura una sola vez

Una persona administradora debe crear el secreto `TAURI_SIGNING_PRIVATE_KEY` en el repositorio de GitHub. La guía [ACTUALIZACIONES.md](ACTUALIZACIONES.md) explica dónde está la clave privada y cómo cargarla. Los colaboradores que solo publican versiones no necesitan conocer la clave ni tener acceso para leerla; sí necesitan permiso para subir a `main` y crear etiquetas.

El repositorio también debe tener habilitado GitHub Actions. Si la rama `main` está protegida contra pushes directos, integra primero el trabajo mediante Pull Request; para ejecutar el publicador, quien esté autorizado debe tener permiso para subir el commit automático de versión a `main` y crear tags.

## 5. Qué hacen las actualizaciones automáticas

- El launcher consulta `latest.json` en GitHub Releases.
- Si encuentra una versión nueva, ofrece descargarla desde la configuración o al iniciar.
- Tauri verifica la firma antes de instalar. Así, un archivo modificado o firmado con otra clave se rechaza.
- Para cambiar la versión, se usa el comando `npm run publicar`; Actions hace la compilación y publicación remotas.

La versión Tauri antigua no se puede actualizar sola si aún no contiene este updater. Sus usuarios deben instalar una vez la versión puente `1.1.6`; las posteriores se pueden recibir desde el launcher. Consulta [ACTUALIZACIONES.md](ACTUALIZACIONES.md) para el proceso detallado y los casos de error.

## 6. Gist, whitelist y secretos

- El catálogo de eventos/modpacks y la whitelist de visibilidad se administran desde **Configuración** del launcher.
- La documentación de activación y publicación del modpack está en [ADMINISTRAR-MODPACK.md](ADMINISTRAR-MODPACK.md).
- El acceso de administración del Gist usa un token de GitHub. El launcher lo guarda en el almacén seguro del sistema, no en el repositorio.
- La clave privada del updater sirve para firmar versiones. No la confundas con el token de GitHub/Gist: cumplen funciones distintas.
- Nunca guardes tokens, contraseñas, claves `.key`/`.pem` ni archivos `.env` en commits, capturas o mensajes.

## 7. Si algo falla

- **No arranca el modo desarrollo:** vuelve a ejecutar `npm ci`, verifica Rust y revisa el primer error de `npm run tauri:dev`.
- **Git dice que el directorio no está limpio:** termina o confirma los cambios del equipo antes de publicar. El comando no los agrega por su cuenta.
- **GitHub rechaza la subida:** revisa acceso a `main`, permiso de crear tags y conexión. Si quedó un release commit local, repite el mismo comando para reintentar.
- **Actions falla por clave de firma:** quien administra GitHub debe configurar el secreto indicado en `ACTUALIZACIONES.md`.
- **Actions terminó pero los usuarios no ven la versión:** revisa que la release sea pública, tenga `latest.json` y que su versión sea mayor que la instalada.
- **Una función Rust no está disponible en JavaScript:** confirma que está registrada en `src-tauri/src/lib.rs` y expuesta por `preload-tauri.js`.

Si reportas un problema, incluye qué comando ejecutaste, el mensaje de error y la versión del launcher. No incluyas tokens, claves ni datos de inicio de sesión.
