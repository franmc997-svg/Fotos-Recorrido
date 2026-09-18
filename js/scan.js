/* Escaneo de la biblioteca: leer ubicación y fecha de miles de fotos sin
   decodificar ni una.

   Decodificar una foto de 12 MP cuesta entre 0,3 s (JPEG) y 2 s (HEIC). Con
   3000 fotos eso son de 15 minutos a 100. Leer solo el EXIF cuesta entre 1 y
   5 ms, y el cuello de botella pasa a ser el disco. Los píxeles se dejan para
   las pocas fotos que acaben siendo un pin. */
(function () {
  const CONCURRENCY = 8;

  /* Clave estable del archivo, no su posición en esta tanda. iOS no deja
     seleccionar miles de fotos de una vez (el propio selector nativo se
     queda atascado preparándolas antes de que la página vea un solo
     archivo), así que escanear tiene que poder hacerse en varias tandas que
     se sumen entre sí. Con un índice posicional (0, 1, 2…) dos tandas
     distintas producen las mismas claves y una pisa a la otra; con esto no. */
  function fileKey(file) {
    return file.name + '::' + file.size + '::' + file.lastModified;
  }

  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function kindOf(file) {
    const e = extOf(file.name);
    const t = (file.type || '').toLowerCase();
    if (e === 'heic' || e === 'heif' || t === 'image/heic' || t === 'image/heif') return 'heic';
    if (e === 'jpg' || e === 'jpeg' || t === 'image/jpeg') return 'jpeg';
    if (e === 'png' || t === 'image/png') return 'png';
    if (e === 'webp' || t === 'image/webp') return 'webp';
    if (e === 'avif' || t === 'image/avif') return 'avif';
    if (e === 'dng' || e === 'tif' || e === 'tiff') return 'tiff';
    if (e === 'mov' || e === 'mp4' || (t || '').startsWith('video/')) return 'video';
    return 'otro';
  }

  const PICK = ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'Make', 'Model', 'Orientation'];

  // Fotos "optimizadas" en iCloud (no descargadas al dispositivo), un HEIC
  // con una caja corrupta o cualquier archivo raro pueden dejar colgada la
  // lectura de un único archivo para siempre. Sin límite de tiempo, esa
  // foto se lleva el escaneo entero con ella: con 400 fotos basta una mala
  // para que la barra de progreso no vuelva a moverse.
  const FILE_TIMEOUT_MS = 20000;

  function withTimeout(promise, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ __timedOut: true }), ms);
      promise.then(
        (v) => { clearTimeout(t); resolve(v); },
        () => { clearTimeout(t); resolve({ __timedOut: true }); }
      );
    });
  }

  async function readOne(file) {
    const kind = kindOf(file);
    const rec = {
      name: file.name, size: file.size, kind,
      lat: null, lng: null, takenAt: null, model: null, failed: false
    };
    if (kind === 'video' || kind === 'otro') { rec.failed = true; return rec; }

    try {
      let gps = null, meta = null;
      if (kind === 'heic' || kind === 'avif') {
        const tiff = await Heic.readExifTiff(file);
        if (tiff) {
          gps = await exifr.gps(tiff).catch(() => null);
          meta = await exifr.parse(tiff, PICK).catch(() => null);
        }
      }
      if (!gps && !meta) {
        // JPEG y compañía: exifr lee solo los primeros KB por su cuenta
        gps = await exifr.gps(file).catch(() => null);
        meta = await exifr.parse(file, PICK).catch(() => null);
      }
      if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)
          && (gps.latitude !== 0 || gps.longitude !== 0)) {
        rec.lat = gps.latitude;
        rec.lng = gps.longitude;
      }
      const d = meta && (meta.DateTimeOriginal || meta.CreateDate || meta.ModifyDate);
      if (d instanceof Date && !isNaN(d)) rec.takenAt = d.getTime();
      if (meta && meta.Model) rec.model = String(meta.Model);
    } catch (e) {
      rec.failed = true;
    }
    // Sin fecha EXIF, la del sistema de archivos suele ser correcta en fotos
    // copiadas del teléfono, y es mejor que nada para ordenar el recorrido.
    if (!rec.takenAt && file.lastModified) rec.takenAt = file.lastModified;
    return rec;
  }

  /* Recorre los archivos con un pool de tareas. onProgress recibe
     (hechos, total, ultimoRegistro). Se puede cancelar con state.cancel(). */
  function run(files, opts) {
    const list = [...files];
    const total = list.length;
    const onProgress = (opts && opts.onProgress) || (() => {});
    const conc = (opts && opts.concurrency) || CONCURRENCY;
    const records = new Array(total);
    const refs = new Map(); // fileKey -> File, solo mientras dure la sesión
    let next = 0, done = 0, cancelled = false;

    const promise = (async () => {
      async function worker() {
        while (!cancelled) {
          const i = next++;
          if (i >= total) return;
          const file = list[i];
          let rec = await withTimeout(readOne(file), FILE_TIMEOUT_MS);
          if (rec.__timedOut) {
            // No se abandona el archivo sin dejar rastro: se cuenta como
            // fallido y se sigue, en vez de dejar la barra congelada.
            rec = {
              name: file.name, size: file.size, kind: kindOf(file),
              lat: null, lng: null, takenAt: file.lastModified || null,
              model: null, failed: true, timedOut: true
            };
          }
          rec.idx = fileKey(file);
          records[i] = rec;
          refs.set(rec.idx, file);
          done++;
          if (done % 25 === 0 || done === total) onProgress(done, total, rec);
        }
      }
      await Promise.all(Array.from({ length: Math.min(conc, total) }, worker));
      onProgress(done, total, null);
      return { records: records.filter(Boolean), refs, cancelled, total };
    })();

    return { promise, cancel() { cancelled = true; }, get done() { return done; }, total };
  }

  window.Scan = { run, readOne, kindOf };
})();
