# Fotos Recorrido

Herramienta web para convertir las fotos de un viaje en un mapa-póster: lee la
ubicación GPS del EXIF, pone un pin por foto, une los pines en el orden del
recorrido y exporta la imagen lista para publicar o imprimir.

Todo corre en el navegador. Las fotos no se suben a ningún servidor: se guardan
en el almacenamiento local del propio navegador (IndexedDB).

## Lo primero que conviene saber

**Tu carrete no es un recorrido.** Si tienes miles de fotos de varios años y se
unen todos los puntos por fecha, sale una maraña de casa-trabajo-casa con algún
viaje dentro. Por eso la app primero localiza dónde vives (la celda geográfica
con fotos en más días distintos) y llama viaje a cada tramo continuo de fotos
lejos de ahí. Las fotos de casa no cuentan, y una foto suelta en medio de un
viaje no lo parte en dos.

**Escanear no es importar.** Del carrete solo se leen la ubicación y la fecha
del EXIF: entre 1 y 5 ms por foto, sin decodificar nada y sin copiar nada. Miles
de fotos tardan un par de minutos. Los píxeles solo se tocan en las pocas fotos
que acaban siendo un pin, y solo si tú lo pides.

**HEIC del iPhone: el GPS sí, la imagen bajo demanda.** Ningún navegador
decodifica HEIC por su cuenta. La ubicación y la fecha se leen igual (la app
recorre el contenedor ISOBMFF por su cuenta, porque exifr ignora el campo
`base_offset` de la caja `iloc` y en esos archivos busca el EXIF en el byte 0).
Para *ver* las fotos hace falta libheif compilado a wasm, 960 KB que se cargan
solo cuando los pides y con tu permiso; cada foto tarda 1-2 s en decodificarse.
Sin él todo funciona menos las miniaturas y los pines con foto.

**Muchas fotos no tendrán GPS.** WhatsApp, Telegram, Instagram y las capturas
borran el EXIF. Esas fotos se asignan igualmente al viaje por su fecha, y se
colocan a mano: clic en el mapa, arrastrando el pin, buscando el lugar por
nombre o escribiendo las coordenadas.

## Uso

1. Sirve la carpeta por HTTP y abre `index.html`:

   ```bash
   python3 -m http.server 8000
   # http://localhost:8000
   ```

   Abrirla con doble clic (`file://`) no funciona: el navegador bloquea
   IndexedDB y la carga de los scripts en ese origen.

2. **Biblioteca → Escanear fotos** (o *Carpeta…*). Selecciona todo el carrete.
3. Revisa los viajes detectados. Ajusta el hueco que separa un viaje de otro o
   marca *No descartar las fotos de casa* si el corte no te convence.
4. **Crear mapa** en el viaje que quieras: se dibuja la traza completa y se
   proponen doce pines repartidos por las paradas reales del viaje.
5. En **Paradas**, ajusta la distancia de agrupación y marca a mano cuáles
   quieres como pin.
6. Pulsa *Cargar imágenes de los pines* si quieres verlas (solo entonces se
   decodifica nada).
7. Ajusta encuadre, tema, formato y textos. **Descargar imagen** → PNG o JPG,
   hasta 3×.

## Qué hace

- **Escaneo del carrete** sin decodificar ni copiar fotos, con progreso y
  cancelación, y detección automática de viajes.
- **Traza completa del viaje** dibujada como capa GL (miles de puntos no pesan)
  bajo la ruta de los pines.
- **Paradas con distancia ajustable**: las fotos se agrupan en paradas (fotos
  seguidas en el tiempo y juntas en el espacio). La distancia que decide qué
  cuenta como «el mismo sitio» va de 50 m a 20 km y se ajusta desde la
  interfaz, porque no hay un valor correcto: dentro de una ciudad 100 m
  distingue esquinas, y un viaje entre ciudades necesita decenas de km para no
  acabar con tres montones de pines superpuestos.
- **Elegir los pines a mano**: cada parada tiene una casilla. No todas tienen
  que ser pin; las que no lo son siguen contando para la traza del recorrido.
  Botones para marcar las doce con más peso o quitarlas todas de golpe.
- **Aviso de pines superpuestos**: si a ese zoom hay pines dibujándose unos
  encima de otros, la app lo dice en vez de dejar que se descubra al descargar
  la imagen.
- **Varios mapas** en paralelo, con renombrar, duplicar y eliminar.
- **Pines ligados a la foto**: cada pin es una foto concreta. Clic lo
  selecciona, doble clic abre la foto a pantalla completa, arrastrar lo mueve.
  Cuatro estilos: gota, miniatura circular de la foto, numerado y punto.
- **Ruta** entre los pines, continua o punteada, en el orden por fecha EXIF o
  en un orden manual que puedes reordenar.
- **Seis temas** de póster (incluido uno claro) que recolorean el mapa entero:
  edificios, calles, agua y vegetación.
- **Cinco formatos**: 9:16, 4:5, 1:1, 3:2 y póster 2:3.
- **Textos**: título, subtítulo (se rellena solo con el país/provincia de la
  primera foto), coordenadas del centro y leyenda numerada con los títulos de
  las fotos.
- **Exportar/importar el proyecto** como un `.frmap.json` que lleva las fotos
  dentro, para pasarlo a otro ordenador o guardarlo como respaldo.
- **Búsqueda de lugares** (Nominatim/OSM) para encuadrar el mapa o ubicar una
  foto por nombre.

## La vista previa es la imagen

El editor y el exportador comparten una única especificación de diseño
(`Exporter.LAYOUT` en `js/export.js`, reflejada en `css/style.css` con unidades
`cqw`): posiciones de línea base, interletrado y geometría de los pines. El
encuadre también se conserva — al exportar se sube el zoom en
`log2(anchoExportado / anchoEditor)`, porque un lienzo más grande al mismo zoom
mostraría más superficie en lugar del mismo recorte.

La exportación se hace con un segundo mapa oculto, del tamaño final, forzando
`devicePixelRatio` durante su creación; los pines y el texto se pintan encima
en un canvas 2D con la proyección de ese mapa. No se usa html2canvas: con
tiles servidos desde otro origen el canvas queda contaminado y `toBlob` falla.

## Pruebas

La detección de viajes tiene una prueba sin dependencias sobre un carrete
sintético de 3357 fotos (residencia, cuatro viajes, 20% sin GPS):

```bash
node tests/trips.test.js
```

El resto (escaneo de HEIC, decodificación, paridad entre la vista previa y la
imagen descargada, exportación a 1×/2×/3×) se ha verificado con Playwright
contra Chromium; esos guiones no están en el repo porque arrastran fixtures
binarios y una dependencia de 300 MB.

## Estructura

```
index.html          interfaz
css/style.css       estilos de la app y del póster (vista previa)
js/themes.js        paletas y formatos
js/heic.js          EXIF de HEIC (parser propio) y decodificador wasm opcional
js/scan.js          escaneo concurrente del carrete
js/trips.js         residencia, viajes, paradas y simplificación de la traza
js/db.js            IndexedDB (mapas y fotos)
js/photos.js        decodificación, reescalado y miniaturas
js/geocode.js       búsqueda y geocodificación inversa (Nominatim)
js/mapview.js       mapa, recoloreado del estilo, pines y ruta
js/export.js        render del póster a PNG/JPG
js/app.js           estado e interfaz
tests/trips.test.js prueba de la detección de viajes
vendor/             maplibre-gl 4.7.1, exifr 7.1.3 y libheif 1.18 (BSD-3 / MIT / LGPL)
```

Las librerías van dentro del repo en vez de venir de un CDN: una dependencia
menos que se puede caer y nada que se cargue desde fuera al abrir la app.

## Límites conocidos

- **Se necesita conexión para los tiles del mapa.** El estilo base viene de
  CARTO (`basemaps.cartocdn.com`). Sin red el mapa sale vacío y la imagen
  exportada también. Se puede cambiar el estilo con `?style=URL` (por ejemplo
  uno de MapTiler con tu clave, o uno local); queda recordado y se borra con
  `?style=reset`.
- **Las fotos se guardan reescaladas** al lado mayor de 1600 px, y solo las que
  son un pin. Los archivos originales no se tocan ni se conservan aquí: esto no
  es un respaldo de tus fotos.
- **Los archivos originales no sobreviven al cierre del navegador.** El
  resultado del escaneo, los mapas y los pines sí, pero para cargar imágenes
  nuevas de fotos que no tenían hay que volver a escanear la carpeta.
- **La detección de viajes necesita fechas.** Si tus fotos no tienen ni fecha
  EXIF ni fecha de archivo fiable, no hay forma de separar viajes.
- **En iPhone hay que escanear por tandas.** El selector de fotos de iOS tarda
  minutos en preparar cientos de imágenes antes de que la página vea ninguna, y
  eso ocurre fuera del alcance de la app. Escanear varias veces suma: cada
  tanda se añade a las anteriores.
- **Los mapas creados antes de esta versión no guardan la lista de fotos del
  viaje**, así que no se pueden reagrupar. Hay un botón para reconstruirla
  desde la biblioteca si sigue escaneada.
- **El almacenamiento es del navegador y de este dispositivo.** Borrar los
  datos del sitio borra los mapas. Exporta el proyecto si quieres conservarlo.
- **La atribución de OpenStreetMap se dibuja siempre** en la imagen, incluso
  con el pie desactivado: la licencia de los datos lo exige.
- **La búsqueda de lugares depende de Nominatim**, que limita a una petición
  por segundo; para uso intensivo hay que poner otro geocodificador.
- No hay vista 3D ni inclinación del mapa: el póster es plano a propósito.

## Licencias

- Datos del mapa: © colaboradores de OpenStreetMap (ODbL).
- Tiles y estilo base: © CARTO.
- [MapLibre GL JS](https://maplibre.org/) — BSD-3-Clause (`vendor/maplibre-gl.LICENSE.txt`).
- [exifr](https://github.com/MikeKovarik/exifr) — MIT (`vendor/exifr.LICENSE.txt`).
- [libheif](https://github.com/strukturag/libheif) vía
  [libheif-js](https://github.com/catdad-experiments/libheif-js) — LGPL
  (`vendor/libheif/LICENSE.txt`).
