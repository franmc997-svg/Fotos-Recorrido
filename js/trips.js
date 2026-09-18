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
    minPhotos: 6,
    minHours: 1  // una salida de una tarde ya cuenta como viaje
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

    const candidates = trips.map((t) => finishTrip(t, home));
    const passes = (t) => t.photos.length >= o.minPhotos && (t.end - t.start) >= o.minHours * 3600000;
    const accepted = candidates.filter(passes)
      .map((t, i) => Object.assign(t, { id: 't' + i }))
      .sort((a, b) => b.start - a.start);

    // Diagnóstico de los tramos que no pasaron el corte: sin esto, "cero
    // viajes" es un callejón sin salida. Con esto se puede decir exactamente
    // qué faltó (fotos o duración) en vez de pedir adivinar.
    accepted.rejected = candidates.filter((t) => !passes(t)).map((t) => ({
      photos: t.photos.length,
      hours: (t.end - t.start) / 3600000,
      start: t.start,
      end: t.end,
      tooFewPhotos: t.photos.length < o.minPhotos,
      tooShort: (t.end - t.start) < o.minHours * 3600000
    }));
    accepted.home = home;
    return accepted;
  }

  /* Paradas: fotos seguidas en el tiempo y juntas en el espacio. Es lo que
     distingue "estuve aquí" de "pasé por aquí en el bus".

     radiusKm es la regla que decide qué cuenta como "el mismo sitio": con
     100 m cada esquina es una parada distinta; con 1 km un barrio entero es
     una sola. No hay un valor correcto, depende del viaje, así que se
     controla desde la interfaz. */
  function stops(photos, opts) {
    const o = Object.assign({ radiusKm: 0.35, gapMin: 120 }, opts);
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

    return out.map((s, i) => {
      const rep = representative(s);
      return Object.assign(s, {
        count: s.photos.length,
        minutes: Math.round((s.end - s.start) / 60000),
        rep,
        id: (rep && rep.idx != null ? String(rep.idx) : 'g' + i)
      });
    });
  }

  /* La foto de la parada más cercana a su centro: la que mejor la representa
     si solo se puede poner un pin. */
  function representative(stop) {
    let best = stop.photos[0], bestD = Infinity;
    for (const r of stop.photos) {
      const d = haversine(stop.lat, stop.lng, r.lat, r.lng);
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  /* Ordena las paradas por peso (fotos + tiempo) y devuelve las n mejores
     que además estén separadas entre sí. Si no hay sitios distintos
     suficientes devuelve menos en vez de apilar varias en el mismo punto:
     doce pines sobre cuatro lugares son cuatro pines y ocho estorbos. */
  function rankGroups(groups, n, opts) {
    const o = Object.assign({ minSepKm: 0.6, floorKm: 0.08 }, opts);
    if (!groups.length) return [];
    const ranked = groups.slice().sort((a, b) =>
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
    return picked.sort((a, b) => a.start - b.start);
  }

  /* Atajo: hasta n fotos representativas directamente desde las fotos. */
  function suggestPins(photos, n, opts) {
    return rankGroups(stops(photos, opts), n, opts).map((g) => g.rep);
  }

  /* Distancia recorrida y medio de transporte estimados a partir de las fotos.

     Dos avisos que condicionan todo el cálculo:

     1. La distancia es una cota INFERIOR. Se suman líneas rectas entre fotos
        consecutivas, así que cuanto menos fotos, más corto sale. Con fotos
        cada pocos minutos se acerca bastante; con cuatro fotos en toda la
        tarde, no.
     2. La velocidad media solo es fiable en un sentido. Si sale alta, hubo
        motor seguro (no se puede fingir). Si sale baja, no dice nada cuando
        el hueco es largo: en un viaje real hay un tramo de 69 km a 4,9 km/h
        de media que fue coche con una noche de por medio, y que por
        velocidad parecería un paseo. Por eso los huecos largos con poca
        velocidad se marcan "sin determinar" en vez de inventar un medio. */
  const MODES = ['pie', 'rueda', 'motor', 'rapido', 'desconocido'];

  const TRAVEL_DEFAULTS = {
    noiseKm: 0.02,        // por debajo de 20 m es ruido de GPS, no movimiento
    walkKmh: 6,
    wheelKmh: 25,
    motorKmh: 120,
    walkMaxKm: 12,        // nadie hace 12 km de un tirón entre dos fotos andando
    confidentGapH: 1.5    // con más hueco que esto, una velocidad baja no prueba nada
  };

  function classifySegment(km, hours, o) {
    const v = hours > 0 ? km / hours : Infinity;
    if (v > o.motorKmh) return { mode: 'rapido', v };
    if (v > o.wheelKmh) return { mode: 'motor', v };
    if (v > o.walkKmh) return { mode: 'rueda', v };
    // Velocidad baja: solo concluyente si además el tramo es corto y seguido.
    if (km > o.walkMaxKm) return { mode: 'motor', v };
    if (hours <= o.confidentGapH) return { mode: 'pie', v };
    return { mode: 'desconocido', v };
  }

  function travelStats(photos, opts) {
    const o = Object.assign({}, TRAVEL_DEFAULTS, opts);
    const list = photos.filter((r) => r.lat != null && r.takenAt != null)
      .sort((a, b) => a.takenAt - b.takenAt);

    const byMode = {};
    for (const m of MODES) byMode[m] = 0;
    const segments = [];
    const gaps = [];
    let totalKm = 0, skipped = 0;

    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const km = haversine(a.lat, a.lng, b.lat, b.lng);
      const hours = (b.takenAt - a.takenAt) / 3600000;
      gaps.push(hours * 60);
      if (km < o.noiseKm) { skipped++; continue; }
      const { mode, v } = classifySegment(km, hours, o);
      byMode[mode] += km;
      totalKm += km;
      segments.push({ km, hours, kmh: v, mode, from: [a.lng, a.lat], to: [b.lng, b.lat] });
    }

    gaps.sort((x, y) => x - y);
    return {
      totalKm,
      byMode,
      segments,
      photos: list.length,
      noiseSkipped: skipped,
      medianGapMin: gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0,
      // Qué parte de la distancia no se pudo atribuir: es la medida honesta
      // de cuánto fiarse del reparto por medio de transporte.
      unknownShare: totalKm > 0 ? byMode.desconocido / totalKm : 0
    };
  }

  const MODE_LABELS = {
    pie: 'a pie',
    rueda: 'en bici o patinete',
    motor: 'en vehículo',
    rapido: 'en avión o tren',
    desconocido: 'sin determinar'
  };
  const MODE_SHORT = {
    pie: 'a pie', rueda: 'en bici', motor: 'en vehículo',
    rapido: 'en avión', desconocido: 'sin determinar'
  };

  function fmtKm(km) {
    if (km < 1) return Math.round(km * 1000) + ' m';
    if (km < 10) return km.toFixed(1).replace('.', ',') + ' km';
    return Math.round(km) + ' km';
  }

  /* Una sola línea para el póster. La calcula este módulo para que el editor
     y la imagen exportada digan exactamente lo mismo. Solo el total: el
     reparto por medio queda en el panel del editor, no en el póster. */
  function travelLine(stats) {
    if (!stats || !(stats.totalKm > 0)) return '';
    return fmtKm(stats.totalKm);
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

  return { haversine, detectHome, detect, stops, representative, rankGroups, suggestPins,
           travelStats, classifySegment, travelLine, fmtKm,
           MODES, MODE_LABELS, MODE_SHORT, TRAVEL_DEFAULTS, simplify, label, DEFAULTS };
}));
