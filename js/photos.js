/* Píxeles de las fotos: decodificar, reescalar y hacer miniatura.

   Esto es lo caro (de 0,3 s por JPEG a 2 s por HEIC), así que solo se ejecuta
   sobre las fotos que el usuario convierte en pin, nunca sobre la biblioteca
   entera. Guardar los originales tampoco es opción: 3000 fotos de iPhone son
   más de 10 GB y la cuota del navegador no da. */
(function () {
  const DISPLAY_MAX = 1600;
  const THUMB_MAX = 240;

  function uid() {
    return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function isHeic(file) {
    return Scan.kindOf(file) === 'heic';
  }

  /* Fuente dibujable en un canvas. Los HEIC pasan por libheif (wasm), que se
     descarga la primera vez que hace falta. */
  async function decode(file) {
    if (isHeic(file)) return await Heic.decodeToCanvas(file);
    if (window.createImageBitmap) {
      try {
        // from-image aplica la rotación EXIF; si no, las verticales salen tumbadas
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (e) { /* abajo el plan B */ }
    }
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('decode'));
        i.src = url;
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  function resizeToBlob(src, max, quality) {
    const sw = src.width, sh = src.height;
    const scale = Math.min(1, max / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    return new Promise((resolve) => {
      c.toBlob((b) => resolve({ blob: b, w, h }), 'image/jpeg', quality);
    });
  }

  /* Añade display + thumb a un registro de foto que ya existe. */
  async function attachPixels(rec, file) {
    const src = await decode(file);
    const display = await resizeToBlob(src, DISPLAY_MAX, 0.85);
    const thumb = await resizeToBlob(src, THUMB_MAX, 0.8);
    if (src.close) src.close();
    rec.display = display.blob;
    rec.thumb = thumb.blob;
    rec.width = display.w;
    rec.height = display.h;
    return rec;
  }

  /* Registro de pin a partir de un registro de escaneo (sin píxeles). */
  function fromScan(rec, mapId) {
    return {
      id: uid(), mapId,
      name: rec.name, caption: '',
      lat: rec.lat ?? null, lng: rec.lng ?? null,
      fromExif: rec.lat != null,
      takenAt: rec.takenAt ?? null,
      order: null, kind: rec.kind || 'jpeg',
      scanIdx: rec.idx ?? null,
      width: null, height: null,
      display: null, thumb: null
    };
  }

  /* Ruta directa para quien arrastra unas pocas fotos: lee EXIF y decodifica
     de una vez. */
  async function ingest(file, mapId, opts) {
    const scanned = await Scan.readOne(file);
    const rec = fromScan(scanned, mapId);
    if (opts && opts.pixels === false) return rec;
    try {
      await attachPixels(rec, file);
    } catch (e) {
      rec.pixelError = isHeic(file) ? 'HEIC' : 'DECODE';
    }
    return rec;
  }

  window.Photos = { ingest, uid, decode, attachPixels, fromScan, isHeic, DISPLAY_MAX, THUMB_MAX };
})();
