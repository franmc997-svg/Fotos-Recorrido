/* Persistencia local. IndexedDB porque los blobs de foto revientan localStorage
   (cuota ~5 MB). Si IndexedDB no está disponible (file://, modo privado en
   algunos navegadores), caemos a un store en memoria y avisamos al usuario. */
(function () {
  const NAME = 'fotos-recorrido';
  const VERSION = 2;
  let db = null;
  let memoryMode = false;
  const mem = { maps: new Map(), photos: new Map(), library: null };

  function open() {
    if (db) return Promise.resolve(db);
    if (memoryMode) return Promise.resolve(null);
    return new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open(NAME, VERSION);
      } catch (e) {
        memoryMode = true;
        return resolve(null);
      }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('maps')) {
          d.createObjectStore('maps', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('library')) {
          // el escaneo del carrete: miles de registros diminutos, sin píxeles
          d.createObjectStore('library', { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains('photos')) {
          const s = d.createObjectStore('photos', { keyPath: 'id' });
          s.createIndex('mapId', 'mapId');
        }
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => { memoryMode = true; resolve(null); };
      req.onblocked = () => { memoryMode = true; resolve(null); };
    });
  }

  function tx(store, mode) {
    return open().then((d) => {
      if (!d) return null;
      return d.transaction(store, mode).objectStore(store);
    });
  }

  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const DB = {
    get memoryMode() { return memoryMode; },

    async ready() { await open(); return !memoryMode; },

    async putMap(doc) {
      doc.updatedAt = Date.now();
      const s = await tx('maps', 'readwrite');
      if (!s) { mem.maps.set(doc.id, structuredClone(doc)); return doc; }
      await wrap(s.put(doc));
      return doc;
    },

    async getMap(id) {
      const s = await tx('maps', 'readonly');
      if (!s) return mem.maps.get(id) || null;
      return (await wrap(s.get(id))) || null;
    },

    async allMaps() {
      const s = await tx('maps', 'readonly');
      let list;
      if (!s) list = [...mem.maps.values()];
      else list = await wrap(s.getAll());
      return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },

    async deleteMap(id) {
      const photos = await DB.photosOf(id);
      await Promise.all(photos.map((p) => DB.deletePhoto(p.id)));
      const s = await tx('maps', 'readwrite');
      if (!s) { mem.maps.delete(id); return; }
      await wrap(s.delete(id));
    },

    async putPhoto(p) {
      const s = await tx('photos', 'readwrite');
      if (!s) { mem.photos.set(p.id, p); return p; }
      await wrap(s.put(p));
      return p;
    },

    async getPhoto(id) {
      const s = await tx('photos', 'readonly');
      if (!s) return mem.photos.get(id) || null;
      return (await wrap(s.get(id))) || null;
    },

    async photosOf(mapId) {
      const s = await tx('photos', 'readonly');
      if (!s) return [...mem.photos.values()].filter((p) => p.mapId === mapId);
      return await wrap(s.index('mapId').getAll(mapId));
    },

    async deletePhoto(id) {
      const s = await tx('photos', 'readwrite');
      if (!s) { mem.photos.delete(id); return; }
      await wrap(s.delete(id));
    },

    async putLibrary(doc) {
      const s = await tx('library', 'readwrite');
      if (!s) { mem.library = doc; return doc; }
      await wrap(s.put(doc));
      return doc;
    },

    async getLibrary(id) {
      const s = await tx('library', 'readonly');
      if (!s) return mem.library && mem.library.id === id ? mem.library : null;
      return (await wrap(s.get(id))) || null;
    },

    async estimate() {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      try { return await navigator.storage.estimate(); } catch (e) { return null; }
    }
  };

  window.DB = DB;
})();
