# Mantenimiento de Cloudflare

## Recursos configurados

- Worker: `migajas-community`.
- API: https://migajas-community.migajas-studio.workers.dev
- Estado: https://migajas-community.migajas-studio.workers.dev/health
- Base D1: `migajas-community`, ID `7da79376-8ddc-4fb5-8f46-950f2dc6e276`.
- Configuración: `cloudflare/wrangler.json`.
- Esquema: `cloudflare/migrations/0001_init.sql`.

Se copiaron inicialmente cuatro perfiles, dos relaciones de amistad y cuatro estados de presencia desde Supabase. Los originales se conservaron. La función `migajas-social` de Supabase ahora redirige las peticiones a Cloudflare para mantener compatibilidad con clientes anteriores.

## Comandos desde la raíz del proyecto

```powershell
npm install
npx wrangler login
npm run community:check
npm run community:test
npm run community:migrate
npm run community:deploy
npm run tauri:build
```

`community:migrate` aplica solo migraciones pendientes. No recrees ni borres la base para actualizar el código. Antes de cambios destructivos, exporta una copia con `npx wrangler d1 export migajas-community --remote --config cloudflare/wrangler.json --output copia-d1.sql` y guarda esa copia en una ubicación privada.

`node scripts/configurar-cloudflare.cjs` configura secretos desde la sesión de Supabase CLI y comprueba el bucket privado. El parámetro `--import-friends` es para una importación inicial, no para sincronización habitual: no debe repetirse después de editar amistades en la nueva base. La variable de entorno `MIGAJAS_OWNER_EMAIL` permite vincular la cuenta de seguridad principal; debe ejecutarla únicamente la persona que administra el proyecto.

Las claves privadas se almacenan en Wrangler Secrets: `SUPABASE_SERVICE_KEY`, `SUPABASE_PUBLIC_KEY` y `OWNER_AUTH_USER_ID`. El cliente solo incluye URL y clave pública. No copies la service role al frontend ni al repositorio. La identidad principal de Minecraft se fija por UUID, no por nombre escrito por el cliente.

La URL pública de Cloudflare se configura mediante `MIGAJAS_COMMUNITY_URL` en `.env.social`; la preparación del frontend la incorpora automáticamente. La función Supabase usa el secreto de ese mismo nombre para redirigir clientes antiguos.

## Seguridad aplicada

Consultas SQL con parámetros, comprobación de permisos por operación, segundo factor reciente, contraseña inicial de cambio obligatorio, almacenamiento privado, validación de ZIP, SHA-256 para archivos subidos, comentarios como texto y límites de frecuencia para acciones de escritura. El visor de skins y el SDK se empaquetan localmente; la política CSP bloquea JavaScript remoto.

Los perfiles no premium conservan la identidad por nombre solicitada para la comunidad. No son prueba de identidad para Administración: los permisos administrativos requieren Microsoft verificado además de Supabase Auth y TOTP.

## Comprobaciones realizadas

Pruebas locales de comunidad sobre SQLite: identidad, permisos, segundo factor vencido, comentarios, bloqueo, privacidad, participación e invitaciones con whitelist. Prueba Rust de SHA-256. Revisión de las pantallas de comunidad en tres tamaños y del tutorial en cinco tamaños. Comprobación remota de CORS, perfil, presencia y rechazo de administración no verificada, retirando después el perfil de prueba.

Estas pruebas no sustituyen un inicio real de Minecraft ni la configuración personal del autenticador. La clave privada del actualizador no estaba disponible: un instalador local puede generarse sin artefactos de actualización; para publicar una actualización automática debe recuperarse la clave original, sin cambiar la clave pública de los clientes ya instalados.

También se comprobó el arranque completo del frontend empaquetado en Chromium con la CSP de Tauri, el visor de skins local y los paneles de comunidad: sin errores JavaScript. El backend pasó 37 operaciones locales y la comprobación remota retiró sus datos de prueba.
