# Tutorial y revisión del launcher

El tour se abre desde el perfil y se ofrece en el primer uso. Incluye eventos, jugar, skin, RAM, ajustes de cada evento, eliminación, amigos y Discord.

## Uso

- **Siguiente** recorre las secciones; **Atrás** permite regresar.
- **Mostrarme dónde** enfoca el control señalado sin activarlo.
- Puedes interactuar con los controles reales. Los cambios y las solicitudes se confirman con sus botones habituales.
- **Salir del tour** o Escape cierran el recorrido. Puedes abrirlo de nuevo desde tu perfil.
- La barra muestra el avance. Si no hay eventos, el recorrido explica las secciones que estarán disponibles después.

## Correcciones confirmadas

- El tutorial no se marca como visto hasta salir o finalizar.
- Escape cierra el recorrido completo y sus ventanas.
- El resaltado no modifica las capas de los modales.
- El doble clic en Siguiente no duplica cargas de secciones.
- Salir mientras cargan los ajustes no vuelve a abrir el tutorial al terminar la carga.
- La apertura de amigos durante el recorrido no duplica la petición.
- El inicio del juego bloquea clics simultáneos y conserva el evento elegido antes de consultar permisos.
- Un error consultando la whitelist impide continuar y ofrece reintentar.
- Los avisos temporales ya no sustituyen un estado de descarga más reciente al desaparecer.
- Se eliminó el registro duplicado del comando de cancelación de descarga en Tauri.

## Validación y alcance

Se comprobó la sintaxis JavaScript y se ejecutaron pruebas de transiciones sin eventos, clic simultáneo y salida durante una carga pendiente. La revisión fue dirigida al tutorial, al inicio y a sus conexiones con el frontend y Tauri. No equivale a una auditoría completa ni a una prueba real de Minecraft, skins o solicitudes entre dos cuentas. El instalador debe volver a compilarse para distribuir estos cambios.

## Asistente local de Migajas

El recorrido incorpora preguntas sugeridas y un campo para escribir dudas. Muestra tres preguntas inicialmente; Ver más preguntas permite consultar todos los temas. El asistente sigue disponible durante los pasos del tour. Guíame hasta allí abre la sección relacionada sin guardar ajustes, enviar solicitudes ni borrar archivos automáticamente.

Es un asistente por reglas, no un modelo generativo: reconoce palabras y frases y devuelve respuestas revisadas de `launcher-assistant.js`. No requiere API, claves ni conexión para responder. Las funciones a las que dirige, como amigos o descargas, sí pueden necesitar Internet. No lee logs, archivos personales ni datos del equipo para diagnosticar problemas. No guarda las preguntas en disco ni las envía a una IA.

Para ampliar sus conocimientos, edita la lista `topics` de `launcher-assistant.js`: cada tema define una pregunta, términos reconocidos, una respuesta y el paso del tour asociado. Las preguntas que no reconoce reciben una respuesta de alcance limitado; una coincidencia por palabras puede resultar imprecisa. No ejecuta instrucciones escritas por el usuario. La preparación del frontend incluye este archivo automáticamente.

Validación: sintaxis del JavaScript del launcher; correspondencia de las 14 preguntas sugeridas con sus temas; siete variantes de texto libre; preguntas desconocidas y texto HTML. No se ha realizado validación visual dentro de la aplicación ni compilado un instalador para esta ampliación.

## Migui, la palomita de Migajas

El asistente tiene una mascota vectorial integrada: Migui, una paloma con un pañuelo del color del tema y pequeñas migajas. Su animación incluye respiración, parpadeo y saludo al tocarla. Respeta la preferencia del sistema de reducir movimiento.

Acompáñame muestra el recorrido y Tengo una duda abre las preguntas en un globo de conversación. La mascota puede minimizarse y recuperarse desde ¿Seguimos? sin perder el paso. Las preguntas conservan las respuestas locales y el botón Llévame, Migui lleva a la sección correspondiente. Se comprobaron sintaxis, IDs únicos, respuestas y transición entre ambos modos; queda pendiente revisar visualmente en Tauri y compilar el instalador.

## Ajustes de layout de Migui

El panel mantiene cabecera y acciones visibles, con desplazamiento solo en el contenido central. Su posición se recalcula al cambiar tamaño, sección o altura del contenido. Se limita al área visible y elige una esquina con menor solapamiento con el control señalado. El resaltado queda detrás del globo para no oscurecerlo. Las respuestas aparecen antes de las sugerencias, y una pregunta nueva devuelve el contenido al inicio.

Validación en Edge/Chromium sin interfaz: 45 escenarios combinando recorrido y preguntas, en 1000×650, 800×600, 640×480, 390×700 y 1280×720. Se comprobaron límites del panel, ausencia de desbordamiento horizontal, botones de navegación visibles y minimizar/restaurar. Se inspeccionaron capturas del paso RAM y una respuesta larga. Estas pruebas usan el HTML/CSS y el JavaScript del proyecto con recursos de red bloqueados; no prueban servicios externos ni sustituyen una ejecución del instalador Tauri.
