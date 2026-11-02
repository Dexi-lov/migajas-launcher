# Capturas y eventos anteriores — 1.2.6

## Capturas

Pulsa la cámara de la barra lateral. El selector incluye las instancias locales que reconoce el launcher, aunque el evento ya no esté disponible. Usa tu tecla de capturas dentro de Minecraft (F2 por defecto) y pulsa Actualizar. Al volver al launcher, la galería también se actualiza si está abierta.

Las imágenes se muestran en páginas de 48 miniaturas, ordenadas de más reciente a más antigua. Ver más carga la siguiente página. Pulsa una imagen para ampliarla; puedes avanzar y retroceder con los botones o las flechas del teclado. Abrir carpeta muestra la ubicación en el explorador. Eliminar captura pide confirmación y borra únicamente ese PNG de la instancia elegida. La galería es local: no sube las imágenes a la comunidad.

Las miniaturas se redimensionan de verdad; no se recorta el archivo PNG. Los archivos dañados muestran una imagen de reserva y un error al abrirlos. Las vistas previas admiten PNG de hasta 64 MiB y 64 megapíxeles. La carpeta sigue disponible para acceder a archivos mayores. No se permiten rutas externas ni enlaces de archivos en las operaciones de lectura y borrado.

## Eventos anteriores (ampliado en 1.2.7)

En el catálogo, junto a Disponibles, está Eventos anteriores. También se abre con el reloj de la barra lateral. Incluye búsqueda, fecha de archivo, etiqueta oficial, número de participaciones confirmadas y la etiqueta Participaste cuando corresponde. Desde una tarjeta puedes buscar tus capturas locales o abrir tu perfil si tienes participación confirmada.

El historial contiene eventos archivados, no borradores ni eventos inventados a partir de fechas. Respeta la whitelist general y la del evento. Descargar y jugar permite instalar e iniciar el modpack sin desarchivarlo, cuando sus archivos de descarga siguen disponibles. Mantiene la whitelist y usa enlaces temporales para los archivos privados. El servidor original puede haber dejado de estar activo. Si no hay una instalación local de ese evento, la galería lo indica y permite seleccionar otra instancia.

Los eventos anteriores instalados aparecen en la barra lateral debajo de una barrita. La lista se recupera del disco al abrir el launcher: no depende de dejar seleccionado el evento. Puedes abrir su configuración o eliminarlos con clic derecho. El paquete se conserva aunque Minecraft no llegue a arrancar; al reintentar se reutiliza la descarga terminada cuando la versión del paquete coincide. Los enlaces privados se solicitan de nuevo al servidor antes de jugar y se sigue comprobando el acceso.

En 1.2.9 se corrigió el cierre nativo de Windows por desbordamiento de pila durante la preparación: los buffers grandes de descarga usan memoria dinámica, y el ejecutable y los hilos de instalación disponen de una pila de 8 MiB. Esta reserva no limita la velocidad de descarga.

Desde 1.2.10, un evento Forge/NeoForge que tenga `loader_version` puede instalar su loader sin `url_loader`: el launcher calcula el enlace del instalador oficial. Los enlaces JAR personalizados y los metadatos de Prism siguen siendo compatibles. Si faltan tanto la versión como un enlace que permita identificarla, se muestra un error explicativo. Los errores de arranque que devuelve Rust se muestran bajo el botón de jugar, en lugar de sustituirse por «No se pudo iniciar el juego». La instalación del modpack se conserva para reintentar.

Para añadir un evento al historial, un administrador autorizado lo selecciona en Administración y pulsa Archivar. También puede archivar eventos que todavía proceden del Gist: se conserva una copia del manifiesto en D1 y se retira del catálogo activo de los clientes actuales. No se borran mundos, capturas ni participaciones. Desarchivar devuelve el evento a borrador; hay que revisarlo y publicarlo nuevamente.

La migración `0002_archive_date.sql` conserva la fecha del archivo, aunque el evento se edite después.

## Comprobaciones

Pruebas Rust de miniaturas PNG válidas, paginación y borrado limitado a la carpeta. Pruebas de comunidad para historial, whitelist, archivo de eventos del Gist y acceso autorizado a eventos archivados. La prueba de interfaz comprueba la instalación desde el historial, la persistencia del botón lateral al reiniciar, su separador y el menú de configuración. También usa capturas sintéticas para abrir la galería, ampliar una imagen, abrir carpeta y eliminar con confirmación. No elimina imágenes reales del usuario. La prueba nativa de descargas instala 32 archivos en paralelo desde un servidor local, comprueba sus hashes y verifica su reutilización.

## Participantes de un evento

Pulsa Ver participantes en la tarjeta. La lista muestra los nombres de las cuentas con participación confirmada por los organizadores y permite abrir sus perfiles. Se carga por páginas de 50. No se deduce participación por estar en la whitelist. Se respetan la whitelist del evento y los bloqueos entre jugadores.
