# Sesión de eventos, amigos y perfiles — 1.2.2

El inicio de sesión local de Microsoft y la verificación del servicio de comunidad eran pasos distintos. La consulta de Minecraft desde Cloudflare recibía HTTP 403; el servicio lo confundía con sesión caducada y bloqueaba a la vez el catálogo, amigos y perfil.

Ahora existe una ruta alternativa de comprobación en `migajas-verify-minecraft`, alojada en Supabase. Usa una credencial privada compartida y comprueba el perfil en Minecraft; no acepta un UUID o nombre como prueba de identidad. Cloudflare genera después una sesión de comunidad firmada de 15 minutos, guardada solo en memoria del launcher. Su caducidad no se prolonga por enviar peticiones.

Si caduca esa sesión, el cliente la renueva. Si caduca la credencial real de Minecraft, restaura la sesión de Microsoft desde el almacén seguro del sistema y reintenta una vez. Varias consultas simultáneas comparten la renovación. Un problema temporal del servidor no cierra la sesión ni se presenta como contraseña incorrecta.

Los permisos administrativos siguen requiriendo la identidad verificada y el segundo factor reciente. La nueva ruta de verificación no permite saltarlos.

Secretos adicionales:

- Cloudflare: `VERIFIER_SECRET`, `COMMUNITY_SESSION_SECRET`.
- Supabase: `MIGAJAS_VERIFIER_SECRET`, con el mismo valor privado que `VERIFIER_SECRET`.

No pongas estos valores en `.env.social` ni en el frontend. Si necesitas rotarlos, ejecuta `node scripts/configurar-cloudflare.cjs --configure-verifier` con acceso a ambos proveedores y vuelve a desplegar el Worker y la función verificadora. Las sesiones de comunidad anteriores se renovarán.

Comprobaciones: ruta alternativa del servidor, rechazo de tokens inválidos, firmas manipuladas, renovación concurrente única, caducidad del ticket, errores temporales y regresiones de botones/inicio de sesión. Las pruebas de interfaz usan un backend simulado; no solicitan contraseñas ni publican credenciales del usuario.
