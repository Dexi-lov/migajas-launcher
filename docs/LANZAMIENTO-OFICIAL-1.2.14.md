# Lanzamiento oficial de Migajas 1.2.14

## Los archivos que van juntos

La compilación firmada se prepara en [GitHub Actions](https://github.com/Dexi-lov/migajas-launcher/actions/workflows/preparar-release.yml). Crea una release **en borrador**, no visible para el público todavía.

Al terminar se descargan en `dist/oficial-1.2.14/`:

- El instalador de Windows terminado en `-setup.exe`.
- Su firma, con exactamente el mismo nombre más `.sig`.
- `latest.json`, que indica la versión, el enlace y la firma para las actualizaciones automáticas.
- `VERIFICACION.txt`, generado cuando se comprueba la firma y la correspondencia entre los tres archivos.

No mezcles este SIG con el instalador local de pruebas: una firma solo sirve para el archivo exacto de la compilación que la creó. Se renovó la clave de firma para este lanzamiento porque la anterior no estaba disponible. Quienes tengan las versiones de prueba anteriores deben instalar esta versión manualmente una vez; después podrán recibir actualizaciones con la nueva clave.

Puedes repetir la comprobación así:

```powershell
node scripts/verificar-release.cjs dist/oficial-1.2.14
```

## Hacerlo público

1. Abre las [releases del repositorio](https://github.com/Dexi-lov/migajas-launcher/releases).
2. Entra en el borrador **Migajas Launcher 1.2.14 — Nueva era** y comprueba que contiene el EXE, su SIG y `latest.json`.
3. Publica esa release cuando estés listo para que todos reciban la actualización. Los launchers antiguos que consultan GitHub podrán encontrarla.
4. Si quieres dejar además una copia en el canal de Cloudflare, abre el launcher con tu cuenta administrativa, entra en **Publicar actualización** y sube ese mismo EXE con ese mismo SIG y las notas. El panel comprueba todo antes de activar la publicación.
5. Conecta Migi siguiendo [Migi en Discord](MIGI-DISCORD.md). En el canal donde quieras presentar la nueva etapa, escribe **`/migi bienvenida`**. El botón Descargar apunta a la última release pública, por eso conviene anunciarlo después del paso 3.

La creación del borrador y la verificación no envían avisos a los jugadores ni publican mensajes en Discord por su cuenta.

## Novedades de bienvenida

El launcher lleva una bienvenida de Migi a la nueva era de Migajas Studio y un resumen de las funciones nuevas. Migui lo muestra al entrar después de actualizar y permite recuperarlo desde el menú del perfil. En Discord, Migi tiene comandos separados para bienvenida, ayuda y novedades.

## Antes de anunciarlo al público

Prueba la instalación en un equipo de pruebas, inicia sesión, abre Amigos y un evento, y revisa las novedades de Migi. Conserva el EXE y el SIG juntos cuando los compartas con el equipo. La firma del actualizador verifica la autenticidad de las actualizaciones; no equivale a un certificado comercial de editor de Windows.
