# Comunidad, perfiles y administración de eventos — versión 1.2

## Para jugadores

Abre **Amigos** en la barra lateral. **Mi perfil** muestra tu cara de Minecraft, presentación, etiquetas y participaciones oficiales. Pulsa el nombre de un amigo para visitar su perfil.

Desde 1.2.13, los comentarios muestran la cara de la skin junto al nombre de su autor. Ambos abren su perfil. La barra superior permite maximizar y restaurar la ventana, tanto antes como después de iniciar sesión. El tutorial adapta su contenido a ventanas pequeñas, mantiene visibles los botones y recoloca el resaltado después de las animaciones.

- Puedes comentar en perfiles de amigos que permitan comentarios. Los comentarios son visibles al visitar el perfil. El autor puede borrar su comentario; el dueño del perfil puede borrar los de su perfil.
- En tu perfil puedes desactivar comentarios y ocultar tu actividad.
- **Bloquear** elimina la amistad e impide nuevas solicitudes, invitaciones y acceso entre esos perfiles. Desbloquear no restaura la amistad.
- Selecciona un evento y pulsa **Invitar** junto a un amigo. Recibirá un aviso dentro del launcher. Las invitaciones caducan a los 15 minutos y no conceden acceso a la whitelist.
- **Listo para el evento** comunica que estás preparado. Tus amigos también pueden ver Descargando, Jugando y Ausente. El nombre y la imagen del evento se muestran si están disponibles en tu catálogo.

## Historial oficial

Abrir una instancia no concede una participación oficial. Un organizador autorizado confirma al jugador desde Administración. La confirmación guarda el nombre del evento y la fecha; archivar ese evento conserva el historial. Si falta una participación, consulta al organizador.

Desde 1.2.12, el perfil muestra únicamente el nombre de cada evento en una etiqueta de color, sin fecha ni texto de confirmación. Para elegir el color, abre Administración de eventos, selecciona el evento, cambia **Color de participación en perfiles** y pulsa **Guardar evento**. La vista previa muestra cómo quedará la etiqueta. El color se aplica a todos los participantes, incluidos los ya registrados y los eventos archivados. Solo pueden cambiarlo las cuentas autorizadas para administrar ese evento. Cambiar el color no obliga a volver a descargar el modpack.

## Primer acceso de ElDexs

1. Inicia sesión en Minecraft con **ElDexs usando Microsoft**.
2. Abre el botón **+** de la barra lateral: Administración de eventos.
3. Los datos iniciales están en `%APPDATA%\MigajasLauncher\administracion\acceso-inicial.txt`. El archivo tiene acceso restringido al usuario de Windows. No lo subas al repositorio ni compartas su contenido.
4. Inicia sesión administrativa y escanea el QR con una aplicación autenticadora. Introduce su código.
5. Cambia la contraseña temporal por una propia, de al menos 14 caracteres. Después vuelve a entrar con la contraseña nueva y el autenticador. Elimina el archivo de acceso inicial una vez que hayas confirmado que puedes entrar.

La contraseña administrativa es independiente de la de Microsoft. El launcher no pide tu contraseña de Microsoft en este formulario.

## Crear y publicar un evento sin editar JSON

1. En Administración elige **Nuevo evento**. Escribe un identificador único, por ejemplo `navidad-2026`, el nombre, la versión de Minecraft y el loader.
2. Elige Java y añade una imagen HTTPS. Puedes activar la whitelist y escribir un nombre o UUID por línea. Para jugadores no premium es más sencillo usar su nombre exacto.
3. Guarda el evento como borrador, sin marcar Visible en el catálogo.
4. En **Subir el modpack**, elige un ZIP con la carpeta `mods` y sus `.jar`. Puedes incluir también `config`, `resourcepacks` y otros archivos del paquete. No incluyas cuentas, contraseñas, ejecutables o la carpeta completa de Java.
5. El launcher comprueba el ZIP y muestra cuántos mods contiene. Pulsa **Subir ZIP** y espera a que termine. El enlace de descarga y la versión se generan automáticamente.
6. Activa **Visible en el catálogo** y guarda. Los jugadores autorizados lo verán al cargar el catálogo.

El límite configurado para subida directa es **50 MiB por ZIP**, acorde al almacenamiento actual. Para un ZIP mayor utiliza el campo **Enlace directo al ZIP** y un alojamiento que permita descarga HTTPS sin iniciar sesión. No sirve un enlace a una página de vista previa. Cambiar ese enlace incrementa la versión del paquete. Una subida directa posterior sustituye la fuente externa.

Los ZIP subidos se guardan en un bucket privado. El servidor comprueba el acceso antes de generar un enlace temporal de descarga. El launcher verifica su SHA-256 antes de extraerlo. Los enlaces externos dependen de la privacidad y disponibilidad del proveedor elegido.

## Administradores y etiquetas

- **Fundador**: ElDexs; puede asignar y revocar etiquetas.
- **Administración**: administra eventos generales y confirma eventos oficiales.
- **Organizador de evento**: edita y publica solo los eventos concretos asignados; confirma participación en esos eventos si son oficiales.
- **Moderación**: elimina comentarios con una sesión administrativa válida.
- **Programador**: publica actualizaciones firmadas del launcher. No concede por sí solo permisos para editar eventos. ElDexs conserva acceso a todas las funciones.

Una etiqueta visible no es una contraseña. Cada operación se comprueba en el servidor con el UUID de Minecraft verificado, la cuenta de seguridad vinculada y un segundo factor confirmado hace menos de 15 minutos. Los permisos revocados dejan de servir en la siguiente operación.

Para añadir un administrador, primero debe iniciar sesión con Microsoft en el launcher. ElDexs selecciona el evento si corresponde, escribe su nombre y asigna la etiqueta. Puede proporcionar el correo para crear su cuenta de seguridad, o el ID de una cuenta que ya exista. La contraseña temporal de una cuenta nueva se muestra una vez; entrégala en privado al destinatario. Su primer acceso exige cambio de contraseña y autenticador.

Para crear una cuenta nueva, rellena **Nombre de Minecraft**, **Etiqueta** y **Correo para crear su cuenta de seguridad**. Deja **ID de cuenta existente** completamente vacío y **Revocar etiqueta** desmarcado. Pulsa **Guardar permisos**: el recuadro **Acceso inicial de la nueva cuenta** mostrará el correo y la contraseña temporal. No hay que crear previamente esta cuenta en Supabase.

Si el correo ya está registrado, entra en el proyecto Supabase del launcher, abre **Authentication → Users**, busca ese correo y copia su **User UID**. Ponlo en **ID de cuenta existente**: este ID corresponde a la cuenta de seguridad de esa persona, no a su UUID de Minecraft ni al ID de ElDexs. Vincular una cuenta existente conserva su contraseña; no genera una temporal nueva.

Se corrigió en el servidor el generador que producía contraseñas temporales de 76 caracteres: Supabase las rechazaba porque su límite es de 72 bytes. Ahora se generan 36 caracteres aleatorios seguros. Los errores distinguen correo ya registrado, ID incorrecto y problemas de conexión o permisos del servidor. Las contraseñas elegidas al cambiarlas deben tener entre 14 y 72 caracteres y no superar 72 bytes.

**Bloquear administración** cierra la sesión administrativa en el launcher. **Cambiar contraseña** permite rotarla después de desbloquear con el segundo factor. Si se pierde el autenticador, el propietario del proyecto debe gestionar la recuperación desde Supabase Auth; no existe un código universal para saltarlo.

## Archivar y revisar cambios

Selecciona el evento y pulsa **Archivar** para ocultarlo sin borrar participaciones. **Desarchivar** lo devuelve a borrador; revisa sus datos y vuelve a publicarlo. ElDexs puede consultar los últimos cambios administrativos en el panel de permisos.

Desde 1.2.14, la lista administrativa separa **Eventos oficiales** y **Eventos no oficiales / pruebas**, incluyendo sus borradores y archivados. El fundador y Administración general pueden seleccionar un evento y pulsar **Eliminar evento**. Se pide confirmación: se retira del catálogo y de Eventos anteriores, se eliminan sus participaciones, invitaciones, asignaciones de organizadores y paquetes alojados en Migajas. Los enlaces externos no se borran del proveedor y las instalaciones locales de los jugadores se conservan.

Un evento eliminado no vuelve a aparecer aunque todavía figure en el Gist antiguo. Su identificador queda reservado; para crear otro evento utiliza uno nuevo. Archivar sigue siendo la opción para conservar el historial y las participaciones.

El apartado exclusivo de actualizaciones se explica en [Publicar desde el launcher](PUBLICAR-DESDE-EL-LAUNCHER.md).

## Servicios y límites

La base de datos y la API de comunidad están en Cloudflare D1 y Workers. Supabase Auth gestiona contraseñas y autenticadores; Supabase Storage guarda los ZIP privados. Los eventos anteriores y la whitelist general siguen siendo compatibles con el Gist existente. La función social antigua redirige a Cloudflare, por lo que las amistades comparten base entre clientes anteriores y nuevos. Las funciones nuevas de interfaz requieren la versión 1.2.

No se ha contratado R2 ni un plan de pago. Los servicios gratuitos tienen límites; no equivalen a capacidad ilimitada. Consulta [Cloudflare D1](https://developers.cloudflare.com/d1/platform/pricing/) y [Supabase Storage](https://supabase.com/docs/guides/storage/uploads/file-limits).

## QR del autenticador (corrección 1.2.4)

Si la versión anterior mostraba una imagen rota, instala 1.2.4 y vuelve a iniciar sesión administrativa. El launcher genera localmente un PNG desde la URI TOTP (o su clave secreta), sin depender del formato de la imagen del SDK y renueva los factores TOTP pendientes al reintentar. Los factores verificados se conservan. Si ya configuraste correctamente el autenticador, usa su código; no se genera otro QR para ese factor.

La prueba de interfaz decodifica el PNG generado con un lector QR y comprueba que contiene exactamente la URI TOTP sintética de prueba; no usa secretos reales ni configura el autenticador del usuario.
