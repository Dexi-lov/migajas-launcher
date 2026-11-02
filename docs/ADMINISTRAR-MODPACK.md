# Instalación del modpack y edición protegida de eventos

## Error de `launcher_profiles.json`

El directorio de Minecraft del launcher es:

```text
%APPDATA%\com.migajas.launcher\minecraft
```

El instalador de Forge/NeoForge comprueba que exista `launcher_profiles.json` o `launcher_profiles_microsoft_store.json`. El motor de instalación de Minecraft descarga la versión vanilla, pero no crea esos archivos porque no usa el launcher oficial. Por eso el instalador terminaba con “There is no minecraft launcher profile…”.

Antes de ejecutar NeoForge, Migajas crea un `launcher_profiles.json` mínimo con un objeto `profiles` vacío. El instalador lo acepta y agrega su perfil de NeoForge. Si ya existe un archivo de perfiles, se conserva y no se sobrescribe.

## Quién puede publicar cambios

La sección **Ajustes → Administración del modpack** permite editar el contenido de `evento_migajas.json` y publicarlo al Gist conectado al launcher. El backend:

1. Recibe el token solo para verificarlo; nunca lo guarda en `localStorage`.
2. Comprueba con GitHub qué cuenta representa y que el Gist y el archivo correspondan a la configuración del launcher.
3. Solo acepta la cuenta propietaria configurada (`Dexi-lov`).
4. Guarda el token en el almacén seguro de credenciales de Windows mediante `keyring`.
5. Al publicar, vuelve a comprobar la cuenta y manda el cambio a la API de GitHub. GitHub rechaza tokens sin permiso de escritura.

El token no se incluye en el ejecutable ni se envía a otros jugadores. **No lo pegues en chats, archivos del proyecto ni en el JSON del evento.** Al desconectar, el launcher borra su copia local; eso no revoca el token en GitHub. Revócalo desde la configuración de GitHub si deja de usarse.

### Preparar el token de administración

1. Inicia sesión en GitHub con la cuenta propietaria del Gist (`Dexi-lov`).
2. En GitHub abre **Settings → Developer settings → Personal access tokens**.
3. Crea un token con vencimiento y el menor permiso disponible para esta tarea: **Gists: write**. Para un token clásico, el permiso equivalente es `gist`.
4. En Migajas abre **Ajustes → Administración del modpack**, pega el token y pulsa **Conectar cuenta propietaria**.
5. El launcher debe mostrar que verificó `@Dexi-lov`; después carga el JSON actual.

El botón **Publicar cambios** valida el JSON y pide confirmación antes de actualizar el Gist. **Recargar desde Gist** descarta los cambios no publicados del cuadro y vuelve a cargar la versión remota.

### Qué protege y qué no

- La escritura desde el launcher necesita un token GitHub autorizado y la cuenta propietaria esperada. Conocer la URL del Gist no sirve para publicar desde esta pantalla.
- El Gist del launcher es público, por lo que su contenido puede leerse aunque el formulario de edición esté cerrado. Un Gist secreto tampoco es privado: quien conoce su enlace puede verlo.
- El Gist actual queda limitado a su propietario. Para permitir que varios mantenedores tengan acceso individual, conviene mover el manifiesto a un repositorio privado de GitHub y dar acceso de escritura a los colaboradores; este panel tendría que integrarse con ese repositorio.
- Esto protege la publicación oficial del manifiesto, no impide que alguien modifique una copia local del launcher o sus archivos. No guardes secretos, contraseñas ni datos privados de jugadores en el Gist.

## Whitelist de visibilidad del launcher

En **Ajustes → Administración del modpack → Whitelist para ver instancias** puedes establecer un código administrador y publicar quién puede ver el catálogo.

### Primera configuración

1. Conecta la cuenta propietaria de GitHub con el token descrito arriba.
2. Crea un código de al menos 8 caracteres. Migajas guarda su hash en el almacén seguro de Windows de ese equipo, no en el Gist.
3. Vuelve a introducir el código para desbloquear el editor.
4. Añade un UUID de Minecraft o username por línea. Puedes usar UUID con o sin guiones. Los usernames no distinguen mayúsculas.
5. Activa **Restringir la visibilidad de las instancias** y pulsa **Guardar whitelist**.

Incluye tu propia cuenta en la lista si también quieres ver las instancias. El archivo remoto `launcher_whitelist.json` tiene este formato:

```json
{
  "enabled": true,
  "allowed": [
    "NombreMinecraft",
    "0123456789abcdef0123456789abcdef"
  ]
}
```

Si todavía no existe el archivo, la whitelist empieza activa y vacía: nadie ve instancias hasta que el administrador añada al menos una cuenta. Cuando `enabled` es `false`, todos pueden ver el catálogo. Si está activo, las cuentas que no coincidan con `allowed` no reciben instancias en la interfaz. El comando Rust de lanzamiento también valida la cuenta, así que no basta con invocarlo directamente para iniciar una instancia oculta. Si no se puede consultar la whitelist remota, el launcher falla de forma cerrada y no muestra el catálogo.

El código administrador se configura por equipo y queda guardado como hash en el almacén de credenciales; no se sincroniza en el Gist. Para cambiarlo, desbloquea la whitelist con el código actual, pulsa **Cambiar código administrador**, escribe el nuevo código dos veces y confirma. El nuevo hash reemplaza al anterior en ese equipo.

Para que otro equipo de administración pueda publicar, conecta allí la cuenta propietaria y configura el código de ese equipo. Cambiarlo en un equipo no cambia los códigos guardados en otros equipos. El Gist solo acepta publicaciones de la cuenta `Dexi-lov`; el código añade una segunda comprobación para modificar la whitelist desde el panel. Si olvidas el código de un equipo, elimina la credencial `github-gist-admin-code-hash` del Administrador de credenciales de Windows en ese equipo y vuelve a configurarlo tras conectar la cuenta propietaria.

## Editar los eventos

El cuadro contiene un array JSON. Cada evento debe ser un objeto y necesita:

- `id`: letras ASCII, números, guion o guion bajo; máximo 64 caracteres. Debe ser único.
- `nombre_evento`: nombre visible.
- `version_mc`: versión de Minecraft, por ejemplo `1.21.1`.
- `tipo_loader`: `neoforge`, `forge`, `fabric`, `quilt` o `vanilla`.
- `java_version`: versión principal de Java que requiere el evento, por ejemplo `21`.
- `version_pack`: número entero de versión del modpack.
- `url_modpack`: URL HTTPS del ZIP del pack.
- `url_loader`: para Forge/NeoForge, URL HTTPS del instalador JAR o del JSON de versión de Prism Launcher (`https://meta.prismlauncher.org/v1/net.neoforged/<version>.json`). Si se da un JSON de Prism, el launcher extrae la versión y descarga el instalador correcto desde Maven. Para Fabric se puede omitir: el launcher consulta Fabric Meta y selecciona una versión estable compatible con `version_mc`.

Ejemplo mínimo de un evento Fabric:

```json
{
  "id": "mi-evento-fabric",
  "nombre_evento": "Mi evento Fabric",
  "version_mc": "1.21.1",
  "tipo_loader": "fabric",
  "java_version": "21",
  "version_pack": 1,
  "url_modpack": "https://github.com/Dexi-lov/modpacks_migajas/releases/download/modpack/NPA2BETA.zip"
}
```

No pongas un enlace manual de Fabric en `url_loader` si no necesitas fijar una versión concreta. Si lo incluyes con el formato oficial `https://meta.fabricmc.net/v2/versions/loader/<version_mc>/<version_fabric>/profile/json`, el launcher solo lo usará cuando esa versión siga apareciendo como compatible para el Minecraft del evento; de lo contrario elegirá una versión estable compatible automáticamente.

Se pueden conservar campos adicionales usados por la interfaz, como `imagen_fondo`, `logo`, `icono`, `video_fondo`, `ip_servidor`, `sponsors` y `whitelist`.

### Actualizar el ZIP del modpack

Cuando reemplaces el contenido del ZIP manteniendo la misma URL, incrementa `version_pack`. El launcher usa ese número y la URL como identificador de la instalación: si ambos coinciden con la última sincronización, reutiliza los archivos locales. Cambiar solo el nombre o la imagen no requiere incrementar la versión. Cambiar la URL hace que se descargue el nuevo archivo.

El archivo debe ser un ZIP que el launcher pueda extraer. Las entradas del ZIP se comprueban para impedir rutas que salgan de la carpeta de instancia. Después de publicar, los launchers leen el manifiesto actualizado al cargar el catálogo; el ZIP se descarga al iniciar el evento si cambió su URL o versión.

## Directorios del launcher

- Minecraft compartido, versiones, bibliotecas y assets: `%APPDATA%\com.migajas.launcher\minecraft`
- Archivos y configuración de cada evento: `%APPDATA%\com.migajas.launcher\instances\<id>`
- Credencial de edición GitHub: almacén seguro de credenciales de Windows; no es un archivo dentro de esas carpetas.
