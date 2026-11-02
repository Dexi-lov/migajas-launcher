# Dónde quedó la clave de firma

Para el lanzamiento oficial 1.2.14 se creó una clave nueva: la privada anterior no estaba disponible y el secreto anterior de GitHub llegaba vacío a la compilación.

La carpeta de este equipo es:

```text
C:\Users\Usuario\AppData\Roaming\MigajasLauncher\signing
```

Contiene:

- **updater.key**: clave privada cifrada. No la compartas ni la pongas dentro del proyecto.
- **updater-password.txt**: contraseña de esa clave. Es privada también.
- **updater.key.pub**: clave pública utilizada por el launcher y el servidor.
- **updater.previous.key.pub**: copia de la clave pública anterior, conservada como referencia.

La carpeta tiene acceso restringido al usuario del equipo y al sistema. Guarda una copia de seguridad privada de la clave y su contraseña en un lugar seguro fuera de este equipo. GitHub ya tiene configurados `TAURI_SIGNING_PRIVATE_KEY` y `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; no hace falta enviarlos por chat para publicar.

## Qué tienen que hacer los jugadores

Quienes tengan los instaladores de prueba anteriores deben instalar manualmente esta versión una vez. Conserva el identificador de la aplicación y sus datos locales; no hace falta borrar las instancias para instalarla. A partir de esta versión, las actualizaciones firmadas con la nueva clave podrán instalarse mediante el actualizador.

## Comprobarla sin mostrarla

La automatización firma un archivo de prueba y verifica que su firma corresponde a la clave pública configurada antes de comenzar la compilación. Si falla, se detiene antes de invertir tiempo compilando. La prueba no imprime la clave ni la contraseña.

No vuelvas a generar otra clave para una actualización normal: conserva esta pareja y su contraseña. Cambiar la clave pública requiere planificar la transición de las versiones ya instaladas.
