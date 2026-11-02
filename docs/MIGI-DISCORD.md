# Migi en Discord

Migi es la palomita de Migajas Studio. Ya tiene su servicio desplegado en Cloudflare: responde aunque tu computadora esté apagada. No hay una IA externa ni se leen las conversaciones del servidor.

## Conectarlo por primera vez

1. La aplicación se llama **Migi**, con ID `1566646982737530920`. Su clave pública está en `cloudflare/migi/wrangler.json`; no es una contraseña.
2. [Añade Migi al servidor Migajas Studio](https://discord.com/oauth2/authorize?client_id=1566646982737530920&scope=bot%20applications.commands&permissions=19456&guild_id=1430303874228555910&disable_guild_select=true). Selecciona el servidor y autoriza los permisos de ver canales, enviar mensajes y mostrar enlaces. No necesita Administrador.
3. En [Discord Developer Portal](https://discord.com/developers/applications/1566646982737530920/bot), abre **Bot** y copia el **Bot Token**. Si Discord exige generar uno nuevo, hazlo tú desde esa pantalla.
4. Abre una terminal en la carpeta de este proyecto y ejecuta:

   ```powershell
   npm run migi:configurar
   ```

5. Pega el token cuando lo solicite y pulsa Enter. La entrada se mantiene oculta. El programa no guarda el token en archivos ni lo imprime. Solo lo utiliza para configurar esta aplicación, ponerle la foto de la palomita y registrar el comando `/migi` en Migajas Studio.
6. Debe aparecer «Migi está conectado». Si indica HTTP 403, comprueba que ya añadiste el bot al servidor. Un HTTP 401 suele indicar un token incorrecto. Si no ves el comando inmediatamente, vuelve a abrir Discord.

El programa también configura automáticamente la dirección **Interactions Endpoint URL**:

```text
https://migi-discord.migajas-studio.workers.dev/interactions
```

Nunca pegues el Bot Token en chats, capturas, Gists o código del repositorio. No hace falta conservarlo en el equipo ni subirlo a Cloudflare para que el bot responda a estos comandos.

## Cómo usarlo

- **`/migi bienvenida`**: publica en el canal actual un anuncio de bienvenida a la nueva era de Migajas, con botones para descargar el launcher y abrir la comunidad. Solo pueden ejecutarlo personas con **Administrar servidor** o **Administrador**. Utilízalo cuando la release oficial ya esté publicada, porque el enlace de descarga apunta a la última release pública.
- **`/migi novedades`**: muestra las mejoras y funciones de la versión configurada.
- **`/migi ayuda tema:`**: permite elegir jugar, skin, ram, controles, amigos, borrar o soporte. La ayuda solo la ve quien la pidió.

Migi funciona mediante comandos de Discord. Esta versión no envía mensajes automáticos al entrar cada miembro ni recibe mensajes privados. Tampoco aparece permanentemente «En línea»: no mantiene una conexión Gateway, pero sus comandos funcionan en la nube.

## Cambiar la bienvenida o las respuestas

Edita `cloudflare/migi/index.ts`. Las novedades se toman de `release-notes.json`. Después comprueba y despliega:

```powershell
npm run test:migi
npm run migi:deploy
```

Si cambias la definición de los comandos en `scripts/configurar-migi.cjs`, repite `npm run migi:configurar`.

## Protección

Cada petición debe tener una firma Ed25519 válida de Discord y una fecha reciente. Se comprueban el ID de la aplicación, el servidor y los permisos antes de publicar la bienvenida. Los mensajes no mencionan automáticamente a `@everyone` ni a roles.

Referencia del protocolo: [Interacciones oficiales de Discord](https://docs.discord.com/developers/interactions/receiving-and-responding).
