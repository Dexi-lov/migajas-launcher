# Corrección de inicio y botones — 1.2.1

La política CSP de producción de Tauri incluye hashes o nonces. Los manejadores HTML `onclick` no quedan autorizados por los hashes de los scripts; por eso fallaban a la vez el acceso Microsoft, el acceso offline, minimizar y cerrar. La prueba anterior aplicaba una CSP de navegador sin reproducir esta condición.

Se eliminaron los manejadores de atributos, se registran los eventos con `addEventListener` y el JavaScript principal vive en `app.js`, incluido en los recursos de Tauri. Los controles críticos se registran antes de esperar la restauración de sesión y otras tareas asíncronas. El inicio de sesión bloquea intentos simultáneos, muestra errores del motor y permite Entrar con Enter. El error de imagen del evento tampoco depende de un atributo `onerror`.

La CSP conserva `script-src 'self'`; los estilos de atributos existentes tienen una directiva explícita. No se habilitaron scripts remotos para solucionar el problema.

Ejecuta `npm run test:ui` en Windows con Microsoft Edge instalado. La prueba usa el preload real y un backend Tauri simulado: verifica que los botones invocan las operaciones correctas, la entrada offline llega a la pantalla principal, funcionan cerrar/minimizar y se abre Amigos. Incluye hashes en la CSP para reproducir las restricciones de producción. No inicia una sesión real de Microsoft ni cierra ventanas reales durante la prueba.
