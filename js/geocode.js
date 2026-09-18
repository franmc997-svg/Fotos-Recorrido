/* Búsqueda de lugares contra Nominatim (OSM). Uso bajo y con debounce: su
   política pide máximo 1 petición por segundo y atribución visible. */
(function () {
  const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
  let controller = null;
  let lastCall = 0;

  async function search(q) {
    q = (q || '').trim();
    if (q.length < 3) return [];
    if (controller) controller.abort();
    controller = new AbortController();

    const wait = Math.max(0, 1000 - (Date.now() - lastCall));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();

    const url = `${ENDPOINT}?format=jsonv2&limit=6&addressdetails=1&accept-language=es&q=${encodeURIComponent(q)}`;
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) return [];
      const data = await res.json();
      return data.map((r) => ({
        label: r.display_name,
        short: r.name || (r.display_name || '').split(',')[0],
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
        bbox: r.boundingbox ? r.boundingbox.map(Number) : null // [south, north, west, east]
      })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
    } catch (e) {
      return [];
    }
  }

  /* Nombre corto de la zona a partir de un punto; para rellenar el subtítulo. */
  async function reverse(lat, lng) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=es&lat=${lat}&lon=${lng}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const d = await res.json();
      const a = d.address || {};
      return a.country || a.state || a.city || null;
    } catch (e) {
      return null;
    }
  }

  window.Geocode = { search, reverse };
})();
