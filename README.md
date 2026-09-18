# Fotos Recorrido

Herramienta web para convertir las fotos de un viaje en un mapa-póster: lee la
ubicación GPS del EXIF, pone un pin por foto, une los pines en el orden del
recorrido y exporta la imagen lista para publicar o imprimir.

Todo corre en el navegador. Las fotos no se suben a ningún servidor: se guardan
en el almacenamiento local del propio navegador (IndexedDB).

## Lo primero que conviene saber

**La mayoría de tus fotos probablemente no tengan GPS.** WhatsApp, Telegram,
Instagram y las capturas de pantalla borran el EXIF al comprimir. De un viaje
real es normal que solo una parte traiga coordenadas. Por eso ubicar a mano no
es un parche aquí, es la mitad de la herramienta: las fotos sin GPS van a una
bandeja «Sin ubicar» y se colocan con un clic en el mapa, arrastrando el pin,
buscando el lugar por nombre o escribiendo las coordenadas.

**HEIC/HEIF (iPhone) no se puede mostrar.** Ningún navegador decodifica HEIC.
De esos archivos se lee el EXIF pero no la imagen, así que se descartan con un
aviso: pásalos a JPG antes (en iOS, Ajustes → Cámara → Formatos → Más
compatible, o exportando como JPG).

## Uso

1. Sirve la carpeta por HTTP y abre `index.html`:

   ```bash
   python3 -m http.server 8000
   # http://localhost:8000
   ```

   Abrirla con doble clic (`file://`) no funciona: el navegador bloquea
   IndexedDB y la carga de los scripts en ese origen.

2. Arrastra las fotos al panel izquierdo.
3. Coloca las que hayan quedado «Sin ubicar».
4. Ajusta encuadre, tema, formato y textos en el panel derecho.
5. **Descargar imagen** → PNG o JPG, hasta 3×.

## Qué hace

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

## Estructura

```
index.html          interfaz
css/style.css       estilos de la app y del póster (vista previa)
js/themes.js        paletas y formatos
js/db.js            IndexedDB (mapas y fotos)
js/photos.js        EXIF, reescalado y miniaturas
js/geocode.js       búsqueda y geocodificación inversa (Nominatim)
js/mapview.js       mapa, recoloreado del estilo, pines y ruta
js/export.js        render del póster a PNG/JPG
js/app.js           estado e interfaz
vendor/             maplibre-gl 4.7.1 y exifr 7.1.3 (BSD-3 / MIT)
```

Las librerías van dentro del repo en vez de venir de un CDN: una dependencia
menos que se puede caer y nada que se cargue desde fuera al abrir la app.

## Límites conocidos

- **Se necesita conexión para los tiles del mapa.** El estilo base viene de
  CARTO (`basemaps.cartocdn.com`). Sin red el mapa sale vacío y la imagen
  exportada también. Se puede cambiar el estilo con `?style=URL` (por ejemplo
  uno de MapTiler con tu clave, o uno local); queda recordado y se borra con
  `?style=reset`.
- **Las fotos se guardan reescaladas** al lado mayor de 1600 px para no agotar
  la cuota del navegador. Los archivos originales no se tocan ni se conservan
  aquí: esto no es un respaldo de tus fotos.
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
