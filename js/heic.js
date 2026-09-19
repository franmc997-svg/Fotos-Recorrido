/* Lectura de HEIC/HEIF (iPhone).

   Dos piezas independientes:

   1. Localizar el EXIF sin decodificar la imagen. No se usa el parser HEIC de
      exifr porque ignora el campo base_offset de la caja iloc y busca el EXIF
      en el byte 0 de archivos que sí lo usan. Aquí se recorre el contenedor a
      mano y se le pasa a exifr solo el bloque TIFF, que sí parsea de sobra.
      Solo se leen unos pocos KB por archivo: con 3000 fotos eso es la
      diferencia entre un minuto y una hora.

   2. Decodificar los píxeles, que requiere libheif compilado a wasm (~960 KB).
      Se carga bajo demanda y nunca durante el escaneo. */
(function () {
  const HEIC_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1'];
  const LIBHEIF_DIR = 'vendor/libheif/';

  function str(view, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  }

  function uintBytes(view, off, size) {
    if (size === 0) return 0;
    if (size === 4) return view.getUint32(off);
    if (size === 8) {
      const hi = view.getUint32(off), lo = view.getUint32(off + 4);
      return hi * 4294967296 + lo; // suficiente hasta 2^53; ningún HEIC llega
    }
    if (size === 2) return view.getUint16(off);
    if (size === 1) return view.getUint8(off);
    let n = 0;
    for (let i = 0; i < size; i++) n = n * 256 + view.getUint8(off + i);
    return n;
  }

  /* Cabecera de caja ISOBMFF: tamaño(4) + tipo(4), con tamaño 1 = 64 bits
     y tamaño 0 = hasta el final del archivo. */
  function boxHead(view, off, end) {
    if (off + 8 > end) return null;
    let size = view.getUint32(off);
    const type = str(view, off + 4, 4);
    let head = 8;
    if (size === 1) {
      if (off + 16 > end) return null;
      size = uintBytes(view, off + 8, 8);
      head = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < head) return null;
    return { type, start: off, size, body: off + head, end: off + size };
  }

  function children(view, off, end) {
    const out = [];
    let o = off;
    while (o + 8 <= end) {
      const b = boxHead(view, o, end);
      if (!b) break;
      out.push(b);
      o = b.end;
    }
    return out;
  }

  function isHeicBuffer(buf) {
    if (buf.byteLength < 16) return false;
    const view = new DataView(buf);
    if (str(view, 4, 4) !== 'ftyp') return false;
    const ftypEnd = Math.min(view.getUint32(0), buf.byteLength);
    if (HEIC_BRANDS.includes(str(view, 8, 4))) return true;
    for (let o = 16; o + 4 <= ftypEnd; o += 4) {
      if (HEIC_BRANDS.includes(str(view, o, 4))) return true;
    }
    return false;
  }

  /* Id del item cuyo tipo es 'Exif', dentro de iinf. */
  function exifItemId(view, iinf) {
    const version = view.getUint8(iinf.body);
    let off = iinf.body + 4;
    const countSize = version === 0 ? 2 : 4;
    const count = uintBytes(view, off, countSize);
    off += countSize;
    for (let i = 0; i < count; i++) {
      const infe = boxHead(view, off, iinf.end);
      if (!infe || infe.type !== 'infe') break;
      const v = view.getUint8(infe.body);
      if (v >= 2) {
        const idSize = v === 3 ? 4 : 2;
        const idOff = infe.body + 4;
        const type = str(view, idOff + idSize + 2, 4);
        if (type === 'Exif') return uintBytes(view, idOff, idSize);
      }
      off = infe.end;
    }
    return null;
  }

  /* Posición del item dentro del archivo. A diferencia de exifr, aquí se suma
     base_offset, que es lo que escriben libheif y otros codificadores. */
  function itemExtent(view, iloc, wantedId) {
    const version = view.getUint8(iloc.body);
    let off = iloc.body + 4;
    const b0 = view.getUint8(off++);
    const b1 = view.getUint8(off++);
    const offsetSize = b0 >> 4, lengthSize = b0 & 0xf;
    const baseOffsetSize = b1 >> 4;
    const indexSize = (version === 1 || version === 2) ? (b1 & 0xf) : 0;
    const itemIdSize = version === 2 ? 4 : 2;
    const countSize = version === 2 ? 4 : 2;
    let count = uintBytes(view, off, countSize);
    off += countSize;

    while (count--) {
      const itemId = uintBytes(view, off, itemIdSize);
      off += itemIdSize;
      let construction = 0;
      if (version === 1 || version === 2) {
        construction = view.getUint16(off) & 0xf;
        off += 2;
      }
      off += 2; // data_reference_index
      const baseOffset = uintBytes(view, off, baseOffsetSize);
      off += baseOffsetSize;
      const extentCount = view.getUint16(off);
      off += 2;
      if (itemId === wantedId) {
        // construction_method 1 (idat) y 2 (item) son raros y no se soportan
        if (construction !== 0 || extentCount < 1) return null;
        const o = off + indexSize;
        return {
          offset: baseOffset + uintBytes(view, o, offsetSize),
          length: uintBytes(view, o + offsetSize, lengthSize)
        };
      }
      off += extentCount * (indexSize + offsetSize + lengthSize);
    }
    return null;
  }

  async function slice(file, start, length) {
    const end = Math.min(file.size, start + length);
    if (start >= end) return new ArrayBuffer(0);
    return await file.slice(start, end).arrayBuffer();
  }

  /* Devuelve el bloque TIFF del EXIF, o null. Lee unos pocos KB del archivo. */
  async function readExifTiff(file) {
    let head = await slice(file, 0, 65536);
    if (!isHeicBuffer(head)) return null;

    let view = new DataView(head);
    let meta = children(view, 0, head.byteLength).find((b) => b.type === 'meta');
    if (!meta) {
      // La caja meta puede estar más adelante en archivos grandes.
      head = await slice(file, 0, Math.min(file.size, 1048576));
      view = new DataView(head);
      meta = children(view, 0, head.byteLength).find((b) => b.type === 'meta');
      if (!meta) return null;
    }
    if (meta.end > head.byteLength) {
      head = await slice(file, 0, Math.min(file.size, meta.end + 16));
      view = new DataView(head);
      meta = children(view, 0, head.byteLength).find((b) => b.type === 'meta');
      if (!meta || meta.end > head.byteLength) return null;
    }

    // meta es una FullBox: 4 bytes de versión/flags antes de las subcajas
    const subs = children(view, meta.body + 4, meta.end);
    const iinf = subs.find((b) => b.type === 'iinf');
    const iloc = subs.find((b) => b.type === 'iloc');
    if (!iinf || !iloc) return null;

    const id = exifItemId(view, iinf);
    if (id == null) return null;
    const extent = itemExtent(view, iloc, id);
    if (!extent || !extent.length) return null;

    const payload = await slice(file, extent.offset, extent.length);
    if (payload.byteLength < 8) return null;
    // El payload empieza con un uint32: cuántos bytes hay antes del TIFF
    // (normalmente 6, que son "Exif\0\0").
    const pv = new DataView(payload);
    const shift = 4 + pv.getUint32(0);
    if (shift >= payload.byteLength) return null;
    return payload.slice(shift);
  }

  /* ---------- decodificación de píxeles (bajo demanda) ---------- */

  let libPromise = null;

  function withTimeout(promise, ms, what) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(what + ' no respondió en ' + (ms / 1000) + ' s')), ms);
      promise.then((v) => { clearTimeout(t); resolve(v); },
                   (e) => { clearTimeout(t); reject(e); });
    });
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('no se pudo cargar ' + src));
      document.head.appendChild(s);
    });
  }

  /* El binario se descarga a mano y se le pasa al módulo. Con locateFile la
     factoría devuelve el módulo antes de que el wasm esté instanciado (no
     devuelve una promesa), y la primera llamada a decode() se cuelga para
     siempre sin lanzar nada. */
  function loadLibheif() {
    if (libPromise) return libPromise;
    libPromise = (async () => {
      const res = await fetch(LIBHEIF_DIR + 'libheif.wasm');
      if (!res.ok) throw new Error('falta ' + LIBHEIF_DIR + 'libheif.wasm');
      const wasmBinary = await res.arrayBuffer();
      await loadScript(LIBHEIF_DIR + 'libheif.js');
      if (typeof window.libheif !== 'function') throw new Error('libheif no expuso su factoría');
      const mod = await window.libheif({ wasmBinary });
      if (!mod || typeof mod.HeifDecoder !== 'function') throw new Error('libheif se cargó incompleto');
      return mod;
    })().catch((e) => { libPromise = null; throw e; });
    return libPromise;
  }

  /* Decodifica a un canvas. Cuesta del orden de medio segundo por foto de
     12 MP: solo debe usarse con las fotos que el usuario elige, nunca en
     bloque. */
  async function decodeToCanvas(file) {
    const mod = await withTimeout(loadLibheif(), 60000, 'la carga del decodificador');
    const buf = new Uint8Array(await file.arrayBuffer());
    const decoder = new mod.HeifDecoder();
    const images = decoder.decode(buf);
    if (!images || !images.length) throw new Error('el HEIC no contiene imágenes');
    const image = images[0];
    const w = image.get_width();
    const h = image.get_height();
    if (!w || !h) throw new Error('el HEIC no declara tamaño');
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const data = ctx.createImageData(w, h);
    await withTimeout(new Promise((resolve, reject) => {
      image.display(data, (out) => (out ? resolve() : reject(new Error('display() devolvió vacío'))));
    }), 60000, 'la decodificación');
    ctx.putImageData(data, 0, 0);
    if (image.free) image.free();
    return canvas;
  }

  window.Heic = {
    isHeicBuffer, readExifTiff, decodeToCanvas, loadLibheif,
    get decoderLoaded() { return !!libPromise; }
  };
})();
