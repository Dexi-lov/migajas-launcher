# Paquetes Modrinth (.mrpack)

Desde la versión 1.2.5, Administración acepta `.zip` y `.mrpack`. Un MRPACK suele ser pequeño porque contiene un índice de descargas, en vez de todos los JAR. Los jugadores necesitan conexión a los orígenes de esos archivos durante la instalación.

## Publicar

1. Selecciona un archivo `.mrpack` en Subir el modpack.
2. La vista previa lee `modrinth.index.json` y rellena Minecraft, loader, versión del loader y Java. Revisa y guarda el evento.
3. Sube el paquete. Después activa Visible en el catálogo y guarda.
4. También puedes usar un enlace HTTPS directo al archivo MRPACK en el campo de descarga externa.

Se conserva el límite de 50 MiB para el archivo subido al almacenamiento actual; los mods referenciados se descargan después, directamente desde sus orígenes. Cambiar el nombre de un ZIP cualquiera a `.mrpack` no lo convierte en un paquete Modrinth.

## Instalación

El motor detecta el índice por el contenido, descarga los archivos destinados al cliente, sigue sus enlaces alternativos y verifica tamaño, SHA-1 y SHA-512. Omite archivos con `env.client = unsupported`. Incluye los archivos opcionales del cliente por defecto, como parte del paquete seleccionado por el organizador.

Aplica `overrides` y después `client-overrides`, con prioridad de estos últimos. No aplica `server-overrides`. Minecraft, loader y Java se ajustan antes de iniciar la instancia, incluyendo cuando el paquete ya estaba instalado.

Mantiene la cancelación y el límite de velocidad del launcher. La instalación usa una carpeta de preparación y no marca el paquete como completo cuando faltan descargas o falla una comprobación.

Desde 1.2.11, durante la descarga se muestra «Descargando archivos del evento…» junto al porcentaje, sin nombres ni rutas de los mods. Los errores de hashes, orígenes y descargas tampoco identifican el archivo. Esto evita revelar la lista en la interfaz de descarga; los archivos instalados siguen siendo accesibles en el equipo del jugador.

El mismo clic en Jugar descarga, instala y abre Minecraft. El loader y Java obtenidos del MRPACK se aplican al primer arranque y a los siguientes. Actualizar los botones de instalaciones locales no bloquea el inicio. Los avisos de descarga que lleguen tarde se ignoran una vez terminada esa fase.

Al arrancar Java, el estado cambia a Abriendo Minecraft o Minecraft en ejecución. Si el proceso termina, se libera el botón; un cierre con error deja un aviso en vez de quedarse en Preparando el inicio de Minecraft. Las salidas de Java se guardan en `logs/migajas-launch.log` dentro de la instancia, incluso si Minecraft todavía no pudo crear un informe de error. El archivo se renueva en cada arranque, tiene un límite aproximado de 4 MiB y oculta tokens de autenticación.

Desde 1.2.12, antes del arranque también se extraen las bibliotecas nativas heredadas al directorio del perfil que se ejecutará. Esto corrige `Failed to locate library: lwjgl.dll` en perfiles Forge como 1.18.2, donde los archivos estaban descargados para Minecraft base pero no preparados para Forge. La carpeta resultante se pasa explícitamente a Java.

## Compatibilidad y protección

Soporta el formato 1 para Minecraft con Fabric, Forge, NeoForge o sin loader. Quilt muestra un error explícito porque el motor no lo soporta todavía. Las rutas no pueden salir de la instancia ni sobrescribir metadatos del launcher. Los orígenes HTTPS admitidos son Modrinth CDN, GitHub, GitHub Raw y GitLab, con los hosts de archivos de GitHub para sus redirecciones. Un paquete que necesite otro origen debe revisarse antes de ampliar esta lista.

Referencia: [Especificación oficial de Modrinth](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack).

## Comprobaciones

`node scripts/test-pack-inspector.cjs` valida la inspección de MRPACK y la compatibilidad con ZIP. `cargo test --manifest-path src-tauri/Cargo.toml mrpack --lib` comprueba rutas, dependencias, orígenes, capas de overrides, hashes y cancelación. `npm run test:ui` comprueba también la selección de un MRPACK en el formulario y la detección de Minecraft, Fabric y Java.

Los participantes deben usar Migajas Launcher 1.2.5 o posterior. Los eventos marcados como MRPACK rechazan el inicio desde clientes anteriores con un aviso de actualización.
