/* Detección de viajes dentro de un carrete completo.

   Un carrete de años no es un recorrido: si se unen todos los puntos por
   fecha sale una maraña de casa-trabajo-casa con algún viaje dentro. Aquí se
   localiza primero dónde vive la persona (la celda con más días distintos) y
   se llama viaje a cada tramo continuo de fotos lejos de ahí. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Trips = api;
}(typeof self !== 'undefined' ? self : this, function () {

  const R = 6371; // km

  function haversine(aLat, aLng, bLat, bLng) {
    const toRad = Math.PI / 180;
    const dLat = (bLat - aLat) * toRad;
    const dLng = (bLng - aLng) * toRad;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  const DAY = 86400000;
  const dayKey = (ts) => Math.floor(ts / DAY);

  const DEFAULTS = {
    cellDeg: 0.1,        // ~11 km: tamaño de celda para buscar la residencia
    homeMinDays: 12,     // días distintos para considerar que hay residencia
    awayKm: 80,          // a partir de aquí se considera que estás de viaje
    maxGapHours: 36,     // hueco que parte un viaje en dos
    minPhotos: 8,
    minHours: 4
  };

  /* Celda con fotos en más días distintos: donde duermes, no donde más fotos
     haces (una boda de un día no debe ganarle a tu casa). */
  function detectHome(records, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const cells = new Map();
    for (const r of records) {
      if (r.lat == null || r.takenAt == null) continue;
      const key = Math.round(r.lat / o.cellDeg) + ':' + Math.round(r.lng / o.cellDeg);
      let c = cells.get(key);
      if (!c) { c = { days: new Set(), sumLat: 0, sumLng: 0, n: 0 }; cells.set(key, c); }
      c.days.add(dayKey(r.takenAt));
      c.sumLat += r.lat; c.sumLng += r.lng; c.n++;
    }
    let best = null;
    for (const c of cells.values()) {
      if (!best || c.days.size > best.days.size) best = c;
    }
    if (!best || best.days.size < o.homeMinDays) return null;
    return { lat: best.sumLat / best.n, lng: best.sumLng / best.n, days: best.days.size };
  }

  function bboxOf(list) {
    let w = 180, s = 90, e = -180, n = -90;
    for (const r of list) {
      if (r.lat == null) continue;
      if (r.lng < w) w = r.lng;
      if (r.lng > e) e = r.lng;
      if (r.lat < s) s = r.lat;
      if (r.lat > n) n = r.lat;
    }
    return (e < w) ? null : [w, s, e, n];
  }

  function finishTrip(trip, home) {
    const located = trip.photos.filter((r) => r.lat != null);
    trip.bbox = bboxOf(located);
    if (located.length) {
      trip.centroid = [
        located.reduce((a, r) => a + r.lng, 0) / located.length,
        located.reduce((a, r) => a + r.lat, 0) / located.length
      ];
      trip.maxKm = home
        ? located.reduce((m, r) => Math.max(m, haversine(home.lat, home.lng, r.lat, r.lng)), 0)
        : located.reduce((m, r) => Math.max(m, haversine(trip.centroid[1], trip.centroid[0], r.lat, r.lng)), 0);
    }
    trip.days = new Set(trip.photos.filter((r) => r.takenAt).map((r) => dayKey(r.takenAt))).size;
    trip.located = located.length;
    return trip;
  }

  function detect(records, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const home = detectHome(records, o);

    const timed = records.filter((r) => r.takenAt != null).sort((a, b) => a.takenAt - b.takenAt);
    const located = timed.filter((r) => r.lat != null);

    const trips = [];
    let cur = null;
    const close = () => {
      if (cur && cur.photos.length) trips.push(cur);
      cur = null;
    };

    for (const r of located) {
      const away = !home || haversine(home.lat, home.lng, r.lat, r.lng) > o.awayKm;
      // Las fotos cerca de casa se ignoran, no cierran el viaje: una sola foto
      // suelta (otro dispositivo sincronizado, un GPS que salta) partía el
      // viaje en dos. Lo que lo cierra es el hueco entre fotos de fuera.
      if (!away) continue;
      if (cur && (r.takenAt - cur.end) > o.maxGapHours * 3600000) close();
      if (!cur) cur = { photos: [], start: r.takenAt, end: r.takenAt };
      cur.photos.push(r);
      cur.end = r.takenAt;
    }
    close();

    // Las fotos sin GPS que caen dentro de la ventana del viaje son de ese
    // viaje: normalmente son las que pasaron por WhatsApp o son capturas.
    const unlocated = timed.filter((r) => r.lat == null);
    for (const trip of trips) {
      for (const r of unlocated) {
        if (r.takenAt >= trip.start && r.takenAt <= trip.end) trip.photos.push(r);
      }
      trip.photos.sort((a, b) => a.takenAt - b.takenAt);
    }

    return trips
      .map((t) => finishTrip(t, home))
      .filter((t) => t.photos.length >= o.minPhotos && (t.end - t.start) >= o.minHours * 3600000)
      .map((t, i) => Object.assign(t, { id: 't' + i }))
      .sort((a, b) => b.start - a.start);
  }

  /* Paradas: fotos seguidas en el tiempo y juntas en el espacio. Es lo que
     distingue "estuve aquí" de "pasé por aquí en el bus". */
  function stops(photos, opts) {
    const o = Object.assign({ radiusKm: 0.35, gapMin: 100 }, opts);
    const list = photos.filter((r) => r.lat != null && r.takenAt != null)
      .sort((a, b) => a.takenAt - b.takenAt);
    const out = [];
    let cur = null;
    for (const r of list) {
      if (cur) {
        const far = haversine(cur.lat, cur.lng, r.lat, r.lng) > o.radiusKm;
        const late = (r.takenAt - cur.end) > o.gapMin * 60000;
        if (far || late) { out.push(cur); cur = null; }
      }
      if (!cur) cur = { photos: [], lat: r.lat, lng: r.lng, start: r.takenAt, end: r.takenAt, sumLat: 0, sumLng: 0 };
      cur.photos.push(r);
      cur.sumLat += r.lat; cur.sumLng += r.lng;
      cur.lat = cur.sumLat / cur.photos.length;
      cur.lng = cur.sumLng / cur.photos.length;
      cur.end = r.takenAt;
    }
    if (cur) out.push(cur);
    return out.map((s) => Object.assign(s, {
      count: s.photos.length,
      minutes: Math.round((s.end - s.start) / 60000)
    }));
  }

  /* Elige hasta n fotos representativas: las paradas con más peso, separadas
     entre sí, y devueltas en orden cronológico. Si no hay sitios distintos
     suficientes devuelve menos pines en vez de apilar varios en el mismo
     punto: doce pines sobre cuatro lugares son cuatro pines y ocho estorbos. */
  function suggestPins(photos, n, opts) {
    const o = Object.assign({ minSepKm: 0.6, floorKm: 0.08 }, opts);
    const all = stops(photos, o);
    if (!all.length) return [];
    const ranked = all.slice().sort((a, b) =>
      (b.count + b.minutes / 30) - (a.count + a.minutes / 30));

    const picked = [];
    // Se relaja la separación por pasos: primero lo ideal, y solo si no se
    // llenan los huecos se aceptan paradas más juntas, nunca por debajo del
    // suelo (dos pines más cerca que eso se dibujan uno encima del otro).
    for (let sep = o.minSepKm; picked.length < n && sep >= o.floorKm; sep /= 2) {
      for (const s of ranked) {
        if (picked.length >= n) break;
        if (picked.includes(s)) continue;
        if (picked.some((p) => haversine(p.lat, p.lng, s.lat, s.lng) < sep)) continue;
        picked.push(s);
      }
    }
    return picked
      .sort((a, b) => a.start - b.start)
      .map((s) => {
        let best = s.photos[0], bestD = Infinity;
        for (const r of s.photos) {
          const d = haversine(s.lat, s.lng, r.lat, r.lng);
          if (d < bestD) { bestD = d; best = r; }
        }
        return best;
      });
  }

  /* Douglas-Peucker sobre [lng,lat]: 3000 puntos de traza no aportan más que
     300 y sí pesan al guardar y al dibujar. */
  function simplify(points, epsilon) {
    if (points.length < 3) return points.slice();
    const eps = epsilon == null ? 0.00012 : epsilon;
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [i, j] = stack.pop();
      if (j <= i + 1) continue;
      const [x1, y1] = points[i], [x2, y2] = points[j];
      const dx = x2 - x1, dy = y2 - y1;
      const den = Math.hypot(dx, dy) || 1;
      let maxD = -1, maxK = -1;
      for (let k = i + 1; k < j; k++) {
        const [x, y] = points[k];
        const d = Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / den;
        if (d > maxD) { maxD = d; maxK = k; }
      }
      if (maxD > eps) {
        keep[maxK] = 1;
        stack.push([i, maxK], [maxK, j]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  function label(trip) {
    const f = (ts) => new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short' });
    const y = new Date(trip.end).getFullYear();
    const a = f(trip.start), b = f(trip.end);
    return (a === b ? a : `${a} – ${b}`) + ' ' + y;
  }

  return { haversine, detectHome, detect, stops, suggestPins, simplify, label, DEFAULTS };
}));
