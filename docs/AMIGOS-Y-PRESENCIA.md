> **Versión 1.2:** la comunidad usa Cloudflare D1. La función Supabase se mantiene como puente para clientes anteriores. Para el funcionamiento actual consulta [Comunidad y eventos](COMUNIDAD-Y-EVENTOS.md) y [Cloudflare](CLOUDFLARE.md). Las instrucciones de conexión inicial de abajo describen la instalación anterior.

# Amigos, whitelist y presencia

## Qué hace

El launcher permite enviar solicitudes por username de Minecraft, aceptarlas o eliminarlas. Mientras está abierto, informa si la cuenta está activa en Migajas Launcher o jugando un evento. Al abrir **Amigos y actividad**, también muestra las cuentas registradas que aparecen en la whitelist del evento seleccionado.

Amigos funciona con cuentas Microsoft y con cuentas offline. Para Microsoft, Supabase valida la sesión con Minecraft y usa el UUID oficial. Para offline, Supabase genera un identificador social estable a partir del username normalizado; no se envía un token ni se comprueba que la persona sea dueña de ese nombre. Las cuentas offline se marcan como **OFFLINE** y pueden ser suplantadas, así que no uses esa identidad como prueba de quién es alguien ni compartas información sensible. Su identificador social es independiente del UUID que el juego utiliza para iniciar Minecraft.

## Preparar Supabase (una vez)

1. Crea un proyecto en Supabase y abre **SQL Editor**.
2. En **SQL Editor**, ejecuta en orden los archivos `supabase/migrations/202610300001_social_presence.sql`, `supabase/migrations/202610300002_presence_afk.sql` y `supabase/migrations/202610300003_offline_social_accounts.sql`.
3. Instala Supabase CLI e inicia sesión: `supabase login`.
4. En la raíz del proyecto, enlázalo: `supabase link --project-ref TU_PROJECT_REF`.
5. Publica la función: `supabase functions deploy migajas-social`.
6. Como mantenedor, copia `.env.social.example` a `.env.social` y rellena `MIGAJAS_SUPABASE_URL` y `MIGAJAS_SUPABASE_PUBLISHABLE_KEY` con los valores de **Project Settings → API Keys**.
7. Genera y publica una nueva versión del launcher. El paso `prepare-tauri-frontend.js` incorpora esos valores públicos en el paquete de la aplicación.

Los jugadores solo abren **Amigos y actividad** y buscan por username. No tienen que configurar Supabase. La clave publishable/anon es pública por diseño; nunca uses `secret` ni `service_role` en `.env.social`. La base de datos no permite operaciones directas desde `anon` ni desde usuarios autenticados de Supabase. La función usa la credencial de servidor de Supabase y valida cuentas Microsoft; las cuentas offline se aceptan explícitamente como no verificadas.

Cuando se modifica `supabase/functions/migajas-social/index.ts`, vuelve a ejecutar `npx supabase functions deploy migajas-social` para que el backend remoto reciba los cambios. La migración de AFK amplía los estados permitidos en la tabla de presencia.

### Actualizar un proyecto Supabase ya configurado

1. En el **SQL Editor** del proyecto, ejecuta en orden `supabase/migrations/202610300002_presence_afk.sql` y `supabase/migrations/202610300003_offline_social_accounts.sql` (omite la migración 002 si ya la ejecutaste).
2. Desde la raíz del proyecto enlazado, ejecuta `npx supabase functions deploy migajas-social`.
3. Distribuye la versión nueva del launcher. Los usuarios no tienen que cambiar ninguna opción.

## Cómo funciona la presencia

- Cada launcher conectado manda un heartbeat cada 15 segundos; mientras el panel de amigos está abierto, también vuelve a consultar la lista cada 10 segundos. El botón de refresco permite actualizarla en el momento.
- Si no hay actividad en el launcher durante 5 minutos y Minecraft no está ejecutándose, el estado cambia a `afk`. Al detectar actividad vuelve a `active`.
- Migajas escucha los cambios de estado del proceso Java para marcar `playing` con el ID del evento. El panel muestra el nombre del evento del catálogo. Al terminar el juego vuelve a `active`.
- El estado se muestra como desconectado si el último heartbeat supera los 45 segundos. Esto cubre cierres inesperados y equipos que pierden conexión.
- Al cerrar sesión se elimina la presencia inmediatamente.
- Las solicitudes y amistades se guardan con UUID, no username; cambiar el nombre de Minecraft no rompe la relación.
- La lista de whitelist la consulta la función del servidor desde el manifiesto público del Gist oficial. El launcher no puede solicitar presencia de una lista inventada desde el cliente.

## Límites actuales

El mantenedor configura Supabase una sola vez antes de compilar y distribuir una versión. Los perfiles aparecen en la búsqueda de amigos después de que hayan abierto esa versión y enviado su primer heartbeat. La presencia `playing` muestra que el juego se inició desde este launcher; no verifica la actividad dentro de la ventana del juego. Por eso el estado AFK solo se calcula cuando Minecraft no está ejecutándose.

## Alternativa para catálogo y modpacks sin Gist

Separa el catálogo de los ZIP. Mantén un `events.json` pequeño con la lista de eventos y sube cada modpack como archivo versionado e inmutable, por ejemplo `modpacks/navidad-patas/3.zip`. Para añadir un evento se agrega una entrada al catálogo; para retirarlo se elimina esa entrada. Se puede conservar el ZIP viejo para que las instalaciones existentes sigan reparándose.

Para el almacenamiento, Cloudflare R2 puede servir los archivos grandes por HTTPS y un dominio propio; los buckets son privados por defecto, así que solo se publica lectura cuando se configura explícitamente. R2 no cobra transferencia de salida y actualmente incluye 10 GB-mes y operaciones gratuitas dentro de su cuota mensual. El subdominio `r2.dev` está pensado para desarrollo; en producción conviene un dominio propio. [Documentación de buckets públicos](https://developers.cloudflare.com/r2/buckets/public-buckets/) y [precios de R2](https://developers.cloudflare.com/r2/pricing/).

La publicación debería pasar por un Worker administrativo protegido (por ejemplo, autenticación GitHub OAuth) que pueda agregar o borrar entradas del catálogo. No guardes credenciales de escritura en el launcher. La descarga de los ZIP se mantiene pública y de solo lectura. Como transición, GitHub Releases ya sirve para ZIP versionados, mientras que el Gist actual puede seguir conteniendo el catálogo; mover solo los ZIP a R2 no obliga a cambiar el launcher de inmediato.
