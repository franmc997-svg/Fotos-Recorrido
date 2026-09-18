/* Ingesta de fotos: EXIF (GPS + fecha), reencodeado a tamaño razonable y
   miniatura. Guardar los originales llena la cuota del navegador en un viaje
   real (200 fotos × 4 MB), así que guardamos una versión de pantalla. */
(function () {
  const DISPLAY_MAX = 1600;   // lado mayor de la versión que se muestra
  const THUMB_MAX = 240;      // lado mayor de la miniatura (lista y pines)
  const HEIC = /(\.heic|\.heif)$/i;

  function uid() {
    return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  async function readExif(file) {
    const out = { lat: null, lng: null, takenAt: null };
    if (!window.exifr) return out;
    try {
      const gps = await exifr.gps(file);
      if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
        out.lat = gps.latitude;
        out.lng = gps.longitude;
      }
    } catch (e) { /* sin GPS legible */ }
    try {
      const meta = await exifr.parse(file, ['DateTimeOriginal', 'CreateDate', 'ModifyDate']);
      const d = meta && (meta.DateTimeOriginal || meta.CreateDate || meta.ModifyDate);
      if (d instanceof Date && !isNaN(d)) out.takenAt = d.getTime();
    } catch (e) { /* sin fecha EXIF */ }
    if (!out.takenAt && file.lastModified) out.takenAt = file.lastModified;
    return out;
  }

  async function decode(file) {
    // from-image aplica la rotación EXIF; si no, las verticales salen tumbadas.
    if (window.createImageBitmap) {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (e) { /* fallback abajo */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('decode'));
        i.src = url;
      });
      return img;
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

  /* Devuelve el registro de foto listo para guardar, o {error} si no se pudo. */
  async function ingest(file, mapId) {
    if (HEIC.test(file.name) || file.type === 'image/heic' || file.type === 'image/heif') {
      // El EXIF sí se puede leer; la imagen no la decodifica ningún navegador.
      const ex = await readExif(file);
      return { error: 'HEIC', name: file.name, exif: ex };
    }
    const ex = await readExif(file);
    let bmp;
    try {
      bmp = await decode(file);
    } catch (e) {
      return { error: 'DECODE', name: file.name };
    }
    const display = await resizeToBlob(bmp, DISPLAY_MAX, 0.85);
    const thumb = await resizeToBlob(bmp, THUMB_MAX, 0.8);
    if (bmp.close) bmp.close();

    return {
      id: uid(),
      mapId,
      name: file.name,
      caption: '',
      lat: ex.lat,
      lng: ex.lng,
      fromExif: ex.lat != null,
      takenAt: ex.takenAt || null,
      order: null,
      width: display.w,
      height: display.h,
      display: display.blob,
      thumb: thumb.blob
    };
  }

  window.Photos = { ingest, uid, readExif };
})();
