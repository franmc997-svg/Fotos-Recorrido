/* Persistencia propia.

   Base de datos separada de la herramienta de mapas a propósito. Si los
   proyectos de collage fueran a parar al mismo almacén, aparecerían en el
   selector de mapas de la otra herramienta, que no sabe dibujarlos. Compartir
   código sí; compartir estado, no.

   Aquí sí se guardan píxeles, al contrario que en la otra: un collage son
   decenas de fotos, no miles, y guardarlas a 640 px cuesta un par de megas.
   A cambio, al recargar el proyecto se ve, en vez de quedar vacío esperando a
   que el usuario vuelva a elegir los archivos. */
(function () {
  const NAME = 'fotos-collage';
  const VERSION = 1;
  let db = null, memoryMode = false;
  const mem = new Map();

  function open() {
    if (db) return Promise.resolve(db);
    if (memoryMode) return Promise.resolve(null);
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(NAME, VERSION); }
      catch (e) { memoryMode = true; return resolve(null); }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => { memoryMode = true; resolve(null); };
      req.onblocked = () => { memoryMode = true; resolve(null); };
    });
  }

  function wrap(req) {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  async function store(mode) {
    const d = await open();
    return d ? d.transaction('projects', mode).objectStore('projects') : null;
  }

  window.Store = {
    get memoryMode() { return memoryMode; },
    async ready() { await open(); return !memoryMode; },
    async put(doc) {
      doc.updatedAt = Date.now();
      const s = await store('readwrite');
      if (!s) { mem.set(doc.id, doc); return doc; }
      await wrap(s.put(doc));
      return doc;
    },
    async get(id) {
      const s = await store('readonly');
      if (!s) return mem.get(id) || null;
      return (await wrap(s.get(id))) || null;
    },
    async all() {
      const s = await store('readonly');
      const list = s ? await wrap(s.getAll()) : [...mem.values()];
      return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    async remove(id) {
      const s = await store('readwrite');
      if (!s) { mem.delete(id); return; }
      await wrap(s.delete(id));
    }
  };
})();
