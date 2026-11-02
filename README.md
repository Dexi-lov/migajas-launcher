# Migajas Launcher

Launcher de Minecraft de Migajas Studio, construido con Tauri 2, Rust y una interfaz HTML/JavaScript.

## Empezar

1. Prepara Node.js, Rust y las herramientas de compilación de Windows.
2. Instala las dependencias con `npm ci`.
3. Ejecuta `npm run tauri:dev` para abrir la aplicación durante el desarrollo.

## Publicar una versión

Integra los cambios en `main` y ejecuta:

```powershell
npm run publicar -- --notas "Resumen sencillo de las novedades para los jugadores."
```

El comando aumenta patch, actualiza las versiones, crea un commit y tag, y los sube a GitHub. GitHub Actions compila y publica el instalador Tauri firmado. Para elegir el tipo de aumento, usa `npm run publicar -- minor` o `npm run publicar -- major`.

La primera publicación necesita el secreto `TAURI_SIGNING_PRIVATE_KEY` en GitHub. No guardes la clave privada dentro del repositorio.

## Documentación para el equipo

- [Guía del proyecto y colaboración](docs/GUIA_COLABORADOR.md): estructura, configuración de desarrollo, flujo de trabajo y publicación en lenguaje sencillo.
- [Actualizaciones automáticas](docs/ACTUALIZACIONES.md): firma, instalación, releases, clave y diagnóstico.
- [Publicar desde el launcher](docs/PUBLICAR-DESDE-EL-LAUNCHER.md): rol Programador, subida del instalador firmado, limpieza de la versión anterior y novedades de Migui.
- [Migi en Discord](docs/MIGI-DISCORD.md): conectar el bot y usar sus comandos de bienvenida, ayuda y novedades.
- [Administración de modpacks](docs/ADMINISTRAR-MODPACK.md): publicación y control de eventos/modpacks.
