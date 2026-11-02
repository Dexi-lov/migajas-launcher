# Publicar actualizaciones desde el launcher

## Quién puede hacerlo

ElDexs tiene acceso como fundador. Para otra persona, ElDexs debe asignarle **Programador** desde **Organizar eventos → Etiquetas y permisos**. La persona necesita una cuenta Microsoft verificada, su cuenta de seguridad administrativa y el autenticador. Administración general, Organizador y Moderación no conceden acceso a publicar actualizaciones. Si alguien necesita administrar eventos y publicar el launcher, puede tener Administración general y Programador a la vez.

## Preparar la actualización

Guarda y sincroniza los cambios del proyecto. Desde la raíz puedes publicar una compilación firmada con un solo comando, incluyendo un resumen para los jugadores:

```powershell
npm run publicar -- --notas "Ahora es más fácil organizar los eventos y se han arreglado problemas al entrar a jugar."
```

El comando comprueba el proyecto, aumenta la versión, guarda esas novedades y activa la compilación de GitHub Actions. También puedes mantener las novedades por categorías en `release-notes.json`. El proceso de GitHub utiliza el secreto `TAURI_SIGNING_PRIVATE_KEY` que ya está configurado en el repositorio. La clave privada permanece allí.

Cuando termine la compilación, descarga de la release el instalador de Windows y su archivo de firma, por ejemplo:

- `Migajas Launcher_1.2.15_x64-setup.exe`
- `Migajas Launcher_1.2.15_x64-setup.exe.sig`

La firma y el instalador deben proceder de la misma compilación. Los instaladores locales de pruebas creados sin firma sirven para probar el launcher, pero no pueden publicarse como actualización automática.

## Subir desde el launcher

1. Inicia sesión con Microsoft.
2. Abre **Mi perfil → Publicar actualización**. También está en **Organizar eventos → Actualizaciones del launcher**.
3. Desbloquea el panel con tu cuenta de seguridad y el código del autenticador.
4. Escribe una versión mayor que la publicada, selecciona el EXE y su archivo SIG.
5. Explica qué cambia con palabras sencillas. Por ejemplo: «Ahora puedes separar los eventos de pruebas y el tutorial se adapta mejor a tu ventana». Migui utilizará este texto para avisar a los jugadores.
6. Pulsa **Subir y publicar actualización** y confirma.

El límite actual es de **50 MiB por instalador**. Primero se sube a una zona privada y se comprueban el tamaño, el contenido y la firma original del launcher. Una firma incorrecta no reemplaza la actualización activa. No hay que pasar la clave privada a las personas que suben las actualizaciones.

## Qué se borra de la nube

Después de verificar y activar la versión nueva, el servidor borra el instalador anterior del almacenamiento privado `migajas-launcher-updates`. Durante la subida pueden coexistir temporalmente dos archivos; así la versión anterior sigue funcionando si falla la nueva.

Si el proveedor no permite limpiar en ese momento, el panel lo indica y se reintenta al consultar el estado y cada hora. Las subidas abandonadas se limpian al cumplir 24 horas. No se borran las instancias ni las capturas de los jugadores. Esta limpieza corresponde al almacenamiento de actualizaciones del panel; las releases históricas de GitHub se conservan por separado.

## Cómo llegan a los jugadores

Desde **1.2.14**, el launcher consulta el canal de actualizaciones de Cloudflare, que utiliza el paquete publicado desde este panel y mantiene compatibilidad con las releases de GitHub. La firma se verifica de nuevo al instalar. Las versiones anteriores que todavía usan únicamente GitHub deben recibir primero una versión 1.2.14 o posterior por ese canal, o instalar una de esas versiones manualmente.

Al volver a entrar después de actualizar, Migui muestra las novedades una sola vez. **Ver después** cierra el aviso y **Novedades con Migui**, en el menú del perfil, permite recuperarlo. También puedes preguntarle «¿Qué trae la última actualización?» o «¿Qué se mejoró?». Las respuestas utilizan las notas escritas por el equipo, sin inventar cambios y sin enviar preguntas a una IA externa.

## Para quien mantiene el servidor

- Cloudflare D1 conserva los permisos y el estado de las publicaciones.
- Supabase Storage almacena el instalador en un bucket privado.
- `migajas-verify-update` comprueba la firma y el archivo antes de activar la publicación. Utiliza la credencial compartida del verificador que ya existe en Supabase y Cloudflare; ninguna clave privada llega al navegador.
- `UPDATER_PUBLIC_KEY` de Wrangler debe coincidir con la clave pública configurada en Tauri. Una prueba automatizada comprueba esta correspondencia.
- La actualización activa se cambia en una transacción. Una subida lenta no puede reemplazar una versión más reciente.
- Las operaciones de publicación quedan en el registro administrativo.

Comprobaciones: `npm run community:check`, `npm run community:test`, `node scripts/test-launcher-updates.cjs`, `node scripts/test-launcher-news.cjs` y `npm run test:ui`.
