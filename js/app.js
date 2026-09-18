/* Orquestador de la interfaz: mapas, ingesta de fotos, pines, edición y
   descarga. Estado en memoria + persistencia en IndexedDB con debounce. */
(function () {
  const $ = (id) => document.getElementById(id);

  const state = {
    maps: [],
    mapDoc: null,
    photos: [],
    selectedId: null,
    map: null,
    markers: new Map(),
    thumbUrls: new Map(),
    thumbImgs: new Map(),
    displayUrls: new Map(),
    placing: null,       // id de foto en espera de un clic en el mapa
    styleFailed: false,
    lbIndex: -1,
    library: null,       // { id, records, home, scannedAt }
    fileRefs: new Map(), // índice del escaneo -> File, solo durante la sesión
    trips: [],
    groups: [],
    groupLimit: 0,
    scan: null
  };

  const NO_THUMB = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
    '<rect width="40" height="40" fill="#1d1d2a"/>' +
    '<path d="M8 27l7-8 5 5 4-4 8 7z" fill="#3a3a4d"/>' +
    '<circle cx="14" cy="13" r="3" fill="#3a3a4d"/></svg>');

  function defaultSettings() {
    return {
      title: 'MI RECORRIDO',
      subtitle: '',
      theme: 'neon',
      aspect: '9:16',
      pinStyle: 'teardrop',
      pinSize: 1,
      groupRadiusM: 350,
      showTrack: true,
      trackWidth: 1.2,
      trackOpacity: 0.3,
      trackDotSize: 1.3,
      trackByMode: false,
      showDistance: false,
      showRoute: true,
      routeDashed: true,
      routeWidth: 2.4,
      routeDashLen: 4,
      routeGapLen: 4,
      routeOpacity: 1,
      routeGlow: true,
      titleScale: 1,
      subScale: 1,
      textY: 0,
      textAlign: 'center',
      showLabels: false,
      showCoords: true,
      showFooter: true,
      showLegend: false,
      orderMode: 'date',
      center: [-84.0663, 9.9395],
      zoom: 12,
      bearing: 0
    };
  }

  function theme() {
    return window.THEMES[state.mapDoc.settings.theme] || window.THEMES.neon;
  }

  /* ---------------- avisos ---------------- */
  let bannerTimer = null;
  function banner(msg, kind, sticky) {
    const b = $('banner');
    b.textContent = msg;
    b.className = 'banner ' + (kind || 'info');
    b.hidden = false;
    clearTimeout(bannerTimer);
    if (!sticky) bannerTimer = setTimeout(() => { b.hidden = true; }, 7000);
  }

  function busy(on, text) {
    $('busy').hidden = !on;
    if (text) $('busyText').textContent = text;
  }

  /* ---------------- persistencia ---------------- */
  let saveTimer = null;
  function saveMapSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { DB.putMap(state.mapDoc); }, 400);
  }

  function photoRecord(p) {
    // lo que se guarda: sin URLs de objeto ni nada derivado
    return {
      id: p.id, mapId: p.mapId, name: p.name, caption: p.caption,
      lat: p.lat, lng: p.lng, fromExif: p.fromExif, takenAt: p.takenAt,
      order: p.order, kind: p.kind || null, scanIdx: p.scanIdx ?? null,
      tier: p.tier || 1,
      width: p.width, height: p.height,
      display: p.display, thumb: p.thumb
    };
  }
  function savePhoto(p) { return DB.putPhoto(photoRecord(p)); }

  /* ---------------- orden y ruta ---------------- */
  function placed() { return state.photos.filter((p) => p.lat != null && p.lng != null); }
  function unplaced() { return state.photos.filter((p) => p.lat == null || p.lng == null); }

  function ordered() {
    const list = placed().slice();
    if (state.mapDoc.settings.orderMode === 'manual') {
      list.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
    } else {
      list.sort((a, b) => (a.takenAt ?? 8.64e15) - (b.takenAt ?? 8.64e15));
    }
    return list;
  }

  function reindexManual() {
    ordered().forEach((p, i) => { p.order = i; savePhoto(p); });
  }

  /* ---------------- URLs de objeto ---------------- */
  function thumbUrl(p) {
    if (!state.thumbUrls.has(p.id) && p.thumb) {
      state.thumbUrls.set(p.id, URL.createObjectURL(p.thumb));
    }
    return state.thumbUrls.get(p.id) || '';
  }
  function thumbOrPlaceholder(p) { return thumbUrl(p) || NO_THUMB; }
  function displayUrl(p) {
    if (!state.displayUrls.has(p.id) && p.display) {
      state.displayUrls.set(p.id, URL.createObjectURL(p.display));
    }
    return state.displayUrls.get(p.id) || '';
  }
  function thumbImage(p) {
    if (state.thumbImgs.has(p.id)) return state.thumbImgs.get(p.id);
    const url = thumbUrl(p);
    if (!url) return null;
    const img = new Image();
    img.src = url;
    state.thumbImgs.set(p.id, img);
    return img;
  }
  function releaseUrls() {
    state.thumbUrls.forEach((u) => URL.revokeObjectURL(u));
    state.displayUrls.forEach((u) => URL.revokeObjectURL(u));
    state.thumbUrls.clear();
    state.displayUrls.clear();
    state.thumbImgs.clear();
  }

  /* ---------------- mapa ---------------- */
  function initMap() {
    state.map = MapView.create($('map'), state.mapDoc.settings);

    state.map.on('load', () => {
      MapView.applyTheme(state.map, theme(), state.mapDoc.settings.showLabels);
      MapView.ensureTrackLayers(state.map, theme());
      MapView.ensureRouteLayers(state.map, theme());
      syncTrack();
      syncRoute();
      syncMarkers();
    });

    state.map.on('error', (e) => {
      const msg = String((e && e.error && e.error.message) || '');
      if (!state.styleFailed && /style|Failed to fetch|NetworkError/i.test(msg)) {
        state.styleFailed = true;
        banner('No pude cargar el estilo del mapa. Revisa la conexión; sin los tiles el mapa sale vacío y la exportación también.', 'warn', true);
      }
    });

    state.map.on('moveend', () => {
      const c = state.map.getCenter();
      state.mapDoc.settings.center = [c.lng, c.lat];
      state.mapDoc.settings.zoom = state.map.getZoom();
      state.mapDoc.settings.bearing = state.map.getBearing();
      saveMapSoon();
      updateOverlay();
      renderOverlapHint();
    });

    state.map.on('click', (e) => {
      if (!state.placing) return;
      const p = state.photos.find((x) => x.id === state.placing);
      if (p) {
        p.lat = e.lngLat.lat;
        p.lng = e.lngLat.lng;
        p.fromExif = false;
        if (p.order == null) p.order = placed().length;
        savePhoto(p);
        select(p.id);
        renderLists();
        syncMarkers();
        syncRoute();
      }
      setPlacing(null);
    });
  }

  function syncTrack() {
    if (!state.map || !state.map.getSource('fr-track')) return;
    const s = state.mapDoc.settings;
    MapView.setTrack(state.map, state.mapDoc.track || [], {
      show: s.showTrack && (state.mapDoc.track || []).length > 1,
      theme: theme(),
      width: s.trackWidth,
      opacity: s.trackOpacity,
      dotSize: s.trackDotSize,
      segments: trackSegments()
    });
  }

  /* Los tramos coloreados salen de las fotos del viaje, no de la traza
     guardada: la traza va simplificada y ya no se puede decir qué par de
     fotos generó cada vértice. */
  function trackSegments() {
    if (!state.mapDoc.settings.trackByMode) return null;
    const st = travel();
    return st && st.segments.length ? st.segments : null;
  }

  function syncRoute() {
    if (!state.map || !state.map.getSource('fr-route')) return;
    const coords = ordered().map((p) => [p.lng, p.lat]);
    const s = state.mapDoc.settings;
    MapView.setRoute(state.map, coords, {
      show: s.showRoute,
      dashed: s.routeDashed,
      theme: theme(),
      width: s.routeWidth,
      dashLen: s.routeDashLen,
      gapLen: s.routeGapLen,
      opacity: s.routeOpacity,
      glow: s.routeGlow
    });
  }

  function syncMarkers() {
    if (!state.map) return;
    state.markers.forEach((m) => m.remove());
    state.markers.clear();

    const s = state.mapDoc.settings;
    const scale = MapView.pinScale($('stage').clientWidth, s.pinSize);
    ordered().forEach((p, i) => {
      const el = MapView.buildPinElement(p, i, theme(), s.pinStyle, scale, thumbUrl(p));
      if (p.id === state.selectedId) el.classList.add('is-selected');

      const marker = new maplibregl.Marker({
        element: el,
        anchor: MapView.pinAnchor(s.pinStyle),
        draggable: true
      }).setLngLat([p.lng, p.lat]).addTo(state.map);

      marker.on('dragend', () => {
        const ll = marker.getLngLat();
        p.lat = ll.lat;
        p.lng = ll.lng;
        p.fromExif = false;
        savePhoto(p);
        syncRoute();
        if (p.id === state.selectedId) fillSelection(p);
      });

      el.addEventListener('click', (ev) => { ev.stopPropagation(); select(p.id); });
      el.addEventListener('dblclick', (ev) => { ev.stopPropagation(); openLightbox(p.id); });

      state.markers.set(p.id, marker);
    });
  }

  function setPlacing(id) {
    state.placing = id;
    $('placeMode').hidden = !id;
    $('map').classList.toggle('placing', !!id);
  }

  function fitAll() {
    const list = placed();
    if (!list.length) { banner('Todavía no hay fotos con ubicación.', 'info'); return; }
    if (list.length === 1) {
      state.map.easeTo({ center: [list[0].lng, list[0].lat], zoom: 14 });
      return;
    }
    const b = new maplibregl.LngLatBounds();
    list.forEach((p) => b.extend([p.lng, p.lat]));
    state.map.fitBounds(b, { padding: { top: 90, right: 70, bottom: 260, left: 70 }, duration: 600 });
  }

  function legendItems() {
    return ordered().slice(0, 12).map((p) => (p.caption || p.name || '').slice(0, 40));
  }

  function escapeHtml(t) {
    return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ---------------- biblioteca: escaneo y viajes ---------------- */

  const LIB_ID = 'current';

  function fmtInt(n) { return n.toLocaleString('es'); }

  /* Reconecta pines huérfanos por nombre de archivo tras un nuevo escaneo.
     state.fileRefs solo vive en memoria: en cuanto la pestaña se recarga (muy
     normal en Safari de iPhone, que mata pestañas en segundo plano por
     memoria), esa referencia se pierde para siempre y ya no hay forma de leer
     los píxeles originales de un pin cuya foto no se había cargado todavía.
     Volver a escanear la misma carpeta trae los mismos archivos con un índice
     nuevo: aquí se enlazan de nuevo por nombre, en cualquier mapa, no solo el
     abierto. No es infalible (dos fotos con el mismo nombre en carpetas
     distintas colisionan), pero es gratis y arregla el caso normal. */
  async function reconnectMissingThumbs(refs) {
    const byName = new Map();
    for (const [idx, file] of refs) {
      if (!byName.has(file.name)) byName.set(file.name, idx);
    }
    if (!byName.size) return 0;

    let count = 0;
    const maps = await DB.allMaps();
    for (const m of maps) {
      const photos = await DB.photosOf(m.id);
      for (const p of photos) {
        if (p.thumb || !byName.has(p.name)) continue;
        p.scanIdx = byName.get(p.name);
        await DB.putPhoto(photoRecord(p));
        count++;
        if (state.mapDoc && m.id === state.mapDoc.id) {
          const live = state.photos.find((x) => x.id === p.id);
          if (live) live.scanIdx = p.scanIdx;
        }
      }
    }
    if (count && state.mapDoc) { renderLists(); if (state.selectedId) select(state.selectedId); }
    return count;
  }

  async function startScan(files) {
    const list = [...files].filter((f) => {
      const k = Scan.kindOf(f);
      return k !== 'video' && k !== 'otro';
    });
    if (!list.length) { banner('No encontré fotos en lo que seleccionaste.', 'warn'); return; }

    const prog = $('scanProgress');
    const bar = prog.querySelector('.bar');
    const label = prog.querySelector('span');
    prog.hidden = false;
    $('scanCancelRow').hidden = false;
    $('scanSummary').hidden = true;

    const t0 = performance.now();
    let withGps = 0;
    state.scan = Scan.run(list, {
      onProgress(done, total, rec) {
        if (rec && rec.lat != null) withGps++;
        bar.style.width = ((done / total) * 100).toFixed(1) + '%';
        label.textContent = `${fmtInt(done)} / ${fmtInt(total)} · ${fmtInt(withGps)} con GPS`;
      }
    });

    const { records, refs, cancelled } = await state.scan.promise;
    state.scan = null;
    prog.hidden = true;
    $('scanCancelRow').hidden = true;

    // El escaneo suma a lo que ya había, no lo sustituye: en iOS no se puede
    // seleccionar el carrete entero de una vez (el propio selector nativo se
    // atasca preparando cientos de fotos antes de que la página vea nada), así
    // que escanear tiene que poder hacerse en varias tandas.
    for (const [key, file] of refs) state.fileRefs.set(key, file);
    const reconnected = await reconnectMissingThumbs(refs);

    const prevRecords = (state.library && state.library.records) || [];
    const byKey = new Map(prevRecords.map((r) => [r.idx, r]));
    for (const r of records) byKey.set(r.idx, r);
    const allRecords = [...byKey.values()];

    const located = records.filter((r) => r.lat != null).length;
    const heic = records.filter((r) => r.kind === 'heic').length;
    const timedOut = records.filter((r) => r.timedOut).length;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);

    state.library = {
      id: LIB_ID,
      records: allRecords.map((r) => ({
        idx: r.idx, name: r.name, kind: r.kind,
        lat: r.lat, lng: r.lng, takenAt: r.takenAt
      })),
      home: null,
      scannedAt: Date.now()
    };
    state.library.home = Trips.detectHome(state.library.records);
    await DB.putLibrary(state.library);

    const addedNote = allRecords.length !== records.length
      ? ` (${fmtInt(allRecords.length)} en total con tandas anteriores)` : '';
    $('scanSummary').hidden = false;
    $('scanSummary').innerHTML =
      `<b>${fmtInt(records.length)}</b> fotos leídas en ${secs}&nbsp;s${addedNote} · ` +
      `<b>${fmtInt(located)}</b> con ubicación · ${fmtInt(records.length - located)} sin ella` +
      (heic ? ` · ${fmtInt(heic)} en HEIC` : '') +
      (state.library.home
        ? `<br>Residencia detectada (${state.library.home.days} días distintos): sus fotos no cuentan como viaje.`
        : '<br>No detecté una residencia: trato todas las fotos como viaje.') +
      (timedOut
        ? `<br><b>${fmtInt(timedOut)}</b> foto(s) tardaron demasiado en leerse (posiblemente aún en iCloud, no descargadas al dispositivo) y quedaron sin ubicación.`
        : '') +
      (reconnected
        ? `<br><b>${fmtInt(reconnected)}</b> pin(es) de tus mapas recuperaron el acceso a su foto original: ya puedes cargar su imagen.`
        : '') +
      (cancelled ? '<br><b>Escaneo cancelado.</b>' : '');

    renderTrips();
    if (!state.trips.length) {
      const best = (state.trips.rejected || []).slice().sort((a, b) => b.photos - a.photos)[0];
      banner(
        best
          ? `No salió ningún viaje: el mejor tramo tiene ${fmtInt(best.photos)} fotos y dura ${best.hours < 1 ? Math.round(best.hours * 60) + ' min' : best.hours.toFixed(1) + ' h'}. Baja la duración mínima en «Viajes».`
          : 'No salió ningún viaje. Revisa el hueco entre viajes o la duración mínima en «Viajes».',
        'warn'
      );
    }
  }

  function tripOptions() {
    return {
      maxGapHours: Number($('tripGap').value) || 36,
      minHours: Number($('tripMinHours').value) || 0,
      homeMinDays: $('tripIgnoreHome').checked ? 1e9 : Trips.DEFAULTS.homeMinDays
    };
  }

  /* Explica por qué no salió ningún viaje en vez de dejar un "0" mudo: sin
     esto, un tramo real que solo pierde por 20 minutos o por 2 fotos es
     indistinguible de no haber viajado nunca. */
  function renderTripDiagnostic() {
    const diag = $('tripDiag');
    const rejected = state.trips.rejected || [];
    if (!rejected.length) { diag.hidden = true; return; }

    const best = rejected.slice().sort((a, b) => b.photos - a.photos)[0];
    const bits = [];
    if (!state.trips.home) {
      bits.push('No hay suficientes fotos de fondo para saber dónde vives, así que cuento todo el tramo seguido como un solo candidato a viaje.');
    }
    const motivos = [];
    if (best.tooFewPhotos) motivos.push(`solo tiene ${fmtInt(best.photos)} fotos (mínimo 6)`);
    if (best.tooShort) motivos.push(`dura ${best.hours < 1 ? Math.round(best.hours * 60) + ' min' : best.hours.toFixed(1) + ' h'} (mínimo ${$('tripMinHours').value} h)`);
    bits.push(`El tramo más grande que encontré tiene ${fmtInt(best.photos)} fotos y ${motivos.join(' y ')}. Baja la duración mínima o revisa el hueco entre viajes.`);
    diag.hidden = false;
    diag.textContent = bits.join(' ');
  }

  function renderTrips() {
    const ul = $('tripList');
    ul.innerHTML = '';
    if (!state.library) {
      $('tripCount').textContent = '0';
      $('tripDiag').hidden = true;
      const li = document.createElement('li');
      li.className = 'empty tiny muted';
      li.textContent = 'Escanea tus fotos para ver los viajes.';
      ul.appendChild(li);
      return;
    }
    state.trips = Trips.detect(state.library.records, tripOptions());
    $('tripCount').textContent = state.trips.length;
    renderTripDiagnostic();

    if (!state.trips.length) {
      const li = document.createElement('li');
      li.className = 'empty tiny muted';
      li.textContent = 'Ningún viaje con estos ajustes.';
      ul.appendChild(li);
      return;
    }

    for (const trip of state.trips) {
      const li = document.createElement('li');
      li.className = 'trip-row';
      const km = trip.maxKm ? (trip.maxKm > 900 ? Math.round(trip.maxKm / 100) * 100 : Math.round(trip.maxKm)) : 0;
      li.innerHTML =
        `<div class="trip-meta">
           <div class="trip-title">${escapeHtml(Trips.label(trip))}</div>
           <div class="trip-sub">${fmtInt(trip.photos.length)} fotos · ${trip.located} con GPS · ${trip.days} días · a ${fmtInt(km)} km</div>
         </div>`;
      const btn = document.createElement('button');
      btn.className = 'btn tiny primary';
      btn.textContent = 'Crear mapa';
      btn.addEventListener('click', () => createMapFromTrip(trip));
      li.appendChild(btn);
      li.addEventListener('click', (e) => { if (e.target !== btn) previewTrip(trip); });
      ul.appendChild(li);
    }
  }

  /* Enseña la traza del viaje en el mapa sin crear nada todavía. */
  function previewTrip(trip) {
    if (!state.map) return;
    const pts = trip.photos.filter((p) => p.lat != null).map((p) => [p.lng, p.lat]);
    MapView.setTrack(state.map, Trips.simplify(pts), { show: true, theme: theme() });
    if (trip.bbox) {
      state.map.fitBounds([[trip.bbox[0], trip.bbox[1]], [trip.bbox[2], trip.bbox[3]]],
        { padding: { top: 70, right: 60, bottom: 220, left: 60 }, duration: 500 });
    }
  }

  const SUGGESTED_PINS = 12;
  const TRACK_MAX_POINTS = 4000;

  /* Registro mínimo de cada foto del viaje: es lo que permite reagrupar y
     elegir pines a mano más tarde sin depender de que la biblioteca siga
     escaneada. 669 fotos ocupan unos 70 KB. */
  function tripPhotoRecord(r) {
    return { idx: r.idx, name: r.name, kind: r.kind, lat: r.lat, lng: r.lng, takenAt: r.takenAt };
  }

  async function createMapFromTrip(trip) {
    busy(true, 'Creando el mapa del viaje…');
    try {
      const id = 'm_' + Date.now().toString(36);
      const located = trip.photos.filter((p) => p.lat != null);
      // La traza se guarda completa salvo que sea enorme: simplificarla
      // siempre tiraba dos tercios de los puntos y la ruta se veía peor de lo
      // que realmente fue.
      const pts = located.map((p) => [p.lng, p.lat]);
      const track = pts.length > TRACK_MAX_POINTS ? Trips.simplify(pts) : pts;
      const settings = defaultSettings();
      settings.title = Trips.label(trip);
      if (trip.centroid) {
        settings.center = trip.centroid;
        settings.zoom = 11;
      }
      const doc = {
        id, name: Trips.label(trip), settings, track,
        tripPhotos: trip.photos.map(tripPhotoRecord),
        tripId: trip.id, createdAt: Date.now()
      };
      await DB.putMap(doc);

      const groups = Trips.stops(trip.photos, { radiusKm: settings.groupRadiusM / 1000 });
      const pins = Trips.rankGroups(groups, SUGGESTED_PINS).map((g) => g.rep);
      for (let i = 0; i < pins.length; i++) {
        const rec = Photos.fromScan(pins[i], id);
        rec.order = i;
        await DB.putPhoto(rec);
      }

      const chosen = await loadMaps(id);
      await openMap(chosen);
      switchTab('map');
      if (trip.bbox) {
        state.map.fitBounds([[trip.bbox[0], trip.bbox[1]], [trip.bbox[2], trip.bbox[3]]],
          { padding: { top: 80, right: 60, bottom: 240, left: 60 }, duration: 0 });
      }
      banner(`Mapa creado con ${pins.length} pines sugeridos de ${fmtInt(trip.photos.length)} fotos. ` +
             'Cambia los que quieras y pulsa «Cargar imágenes de los pines» si las quieres ver.', 'ok');
    } finally {
      busy(false);
    }
  }

  /* ---------------- paradas del viaje ---------------- */

  const MAX_GROUP_ROWS = 400;

  /* La distancia de agrupación va de 50 m a 20 km porque ambos extremos hacen
     falta de verdad: dentro de una ciudad se distinguen esquinas, y un viaje
     Madrid-Toledo-Segovia necesita decenas de km para tener un pin por
     ciudad en vez de tres montones de pines superpuestos. Un deslizador
     lineal haría imposible acertar los valores pequeños, así que va por
     pasos. */
  const GROUP_RADII = [50, 100, 150, 200, 300, 350, 500, 750, 1000, 1500, 2000, 3000, 5000, 8000, 12000, 20000];

  function radiusIndex(m) {
    let best = 0, bestD = Infinity;
    GROUP_RADII.forEach((v, i) => { const d = Math.abs(v - m); if (d < bestD) { bestD = d; best = i; } });
    return best;
  }

  function tripPhotos() {
    return (state.mapDoc && state.mapDoc.tripPhotos) || [];
  }

  /* Un grupo "tiene pin" si alguna de sus fotos ya es un pin del mapa. Se
     compara por la clave del escaneo y también por nombre, porque los mapas
     creados antes de que las claves fueran estables guardan otra cosa. */
  function pinnedKeySet() {
    const set = new Set();
    for (const p of state.photos) {
      if (p.scanIdx != null) set.add('k:' + p.scanIdx);
      if (p.name) set.add('n:' + p.name);
    }
    return set;
  }

  function groupPins(group, pinned) {
    return group.photos.filter((r) =>
      (r.idx != null && pinned.has('k:' + r.idx)) || (r.name && pinned.has('n:' + r.name)));
  }

  function computeGroups() {
    const photos = tripPhotos();
    if (!photos.length) return [];
    const radiusKm = (state.mapDoc.settings.groupRadiusM || 350) / 1000;
    return Trips.stops(photos, { radiusKm });
  }

  function fmtDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.round(m) + ' m';
  }

  function fmtClock(ts) {
    return new Date(ts).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  /* Cuántos pines se dibujan pisándose a este zoom. En un viaje entre
     ciudades, doce pines a 134 km de distancia se apilan en tres montones
     ilegibles y el póster sale mal sin que nada avise. */
  function overlappingPins() {
    if (!state.map || !state.mapDoc) return 0;
    const list = ordered();
    if (list.length < 2) return 0;
    const s = state.mapDoc.settings;
    const w = MapView.PIN.baseWidth * MapView.pinScale($('stage').clientWidth, s.pinSize);
    const pts = list.map((p) => state.map.project([p.lng, p.lat]));
    let n = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < w * 0.9) { n++; break; }
      }
    }
    return n;
  }

  function renderOverlapHint() {
    const el = $('groupOverlap');
    if (!el) return;
    const n = overlappingPins();
    el.hidden = n < 2;
    if (n >= 2) {
      el.textContent = `${n} pines se están dibujando encima de otros a este zoom. `
        + 'Sube la distancia de agrupación para tener menos pines, o acércate para separarlos.';
    }
  }

  /* ---------------- distancia recorrida ----------------
     Se calcula sobre TODAS las fotos del viaje, no solo sobre los pines: la
     distancia real la marca el carrete entero, y con doce pines sueltos daría
     una cifra sin sentido. El resultado se cachea porque syncTrack y el panel
     lo piden en cada repintado. */
  let travelCache = { src: null, stats: null, source: '' };
  function travelSource() {
    const trip = tripPhotos();
    if (trip.length > 1) return { list: trip, kind: 'trip' };
    /* Un mapa hecho a mano no tiene el carrete del viaje detrás. Con los
       pines colocados se puede dar una cifra igualmente, pero se avisa de
       que sale de un puñado de puntos y no del recorrido real. */
    const pins = ordered().filter((p) => p.takenAt != null);
    return { list: pins, kind: 'pins' };
  }

  function travel() {
    const { list, kind } = travelSource();
    /* Con los pines la lista se reconstruye en cada llamada, así que la caché
       no puede ir por identidad del array: se usa una firma barata. */
    let key = kind + ':' + list.length;
    if (kind === 'pins') {
      // Son pocos y el usuario los mueve a mano: la firma incluye posiciones.
      for (const p of list) key += '|' + p.lat.toFixed(4) + ',' + p.lng.toFixed(4) + ',' + p.takenAt;
    } else if (list.length) {
      key += ':' + list[0].takenAt + '-' + list[list.length - 1].takenAt;
    }
    if (travelCache.src !== key) {
      travelCache = { src: key, stats: list.length > 1 ? Trips.travelStats(list) : null, source: kind };
    }
    return travelCache.stats;
  }

  function travelLine() {
    const st = travel();
    return st ? Trips.travelLine(st) : '';
  }

  function renderTravel() {
    const sec = $('travelSection');
    if (!sec) return;
    const st = travel();
    if (!st || !(st.totalKm > 0)) { sec.hidden = true; return; }
    sec.hidden = false;
    $('travelTotal').textContent = Trips.fmtKm(st.totalKm);

    const ul = $('travelBreak');
    ul.innerHTML = '';
    Trips.MODES.filter((m) => st.byMode[m] > 0)
      .sort((a, b) => st.byMode[b] - st.byMode[a])
      .forEach((m) => {
        const li = document.createElement('li');
        const pct = Math.round((st.byMode[m] / st.totalKm) * 100);
        li.innerHTML = `<span class="dot" style="background:${MapView.MODE_COLORS[m]}"></span>`
          + `<span>${escapeHtml(Trips.MODE_LABELS[m])}</span>`
          + `<span class="km">${Trips.fmtKm(st.byMode[m])}</span>`
          + `<span class="pct">${pct}%</span>`;
        ul.appendChild(li);
      });

    /* La honestidad del cálculo va escrita al lado de la cifra, no escondida:
       esto es una estimación entre fotos, no un GPS siguiendo la carretera. */
    const partes = [travelCache.source === 'pins'
      ? `Calculado solo con los ${st.photos} pines del mapa, no con el carrete del `
        + 'viaje: es un mínimo, no la distancia recorrida.'
      : 'Estimado en línea recta entre fotos seguidas: por carretera '
        + 'o andando en zigzag, la distancia real es mayor.'];
    if (st.medianGapMin > 20) {
      partes.push(`Entre foto y foto pasan ${Math.round(st.medianGapMin)} min de mediana, `
        + 'así que se pierde todo lo que ocurrió en medio.');
    }
    if (st.unknownShare > 0.15) {
      partes.push(`${Math.round(st.unknownShare * 100)}% de la distancia no se puede `
        + 'atribuir a un medio (tramos cortos con muchas horas de hueco).');
    }
    $('travelNote').textContent = partes.join(' ');
  }

  function groupRowsVisible() { return state.groupLimit || MAX_GROUP_ROWS; }

  function renderGroups() {
    renderTravel();
    const section = $('groupSection');
    const photos = tripPhotos();
    if (!photos.length) {
      section.hidden = true;
      // Solo tiene sentido ofrecer la reconstrucción si hay biblioteca y el
      // mapa tiene pines con fecha con los que emparejar un viaje.
      $('groupRebuild').hidden = !(state.library && state.library.records.length
        && state.photos.some((p) => p.takenAt));
      return;
    }
    $('groupRebuild').hidden = true;
    section.hidden = false;

    state.groups = computeGroups();
    const pinned = pinnedKeySet();
    const onlyPinned = $('groupOnlyPinned').checked;
    const mode = $('groupMode').value;

    $('groupCount').textContent = mode === 'photos'
      ? fmtInt(photos.filter((r) => r.lat != null).length)
      : state.groups.length;
    const located = photos.filter((r) => r.lat != null).length;
    $('groupPhotoCount').textContent = mode === 'photos'
      ? `${fmtInt(state.groups.length)} paradas`
      : `${fmtInt(located)} fotos con GPS`;

    const ul = $('groupList');
    ul.innerHTML = '';
    const limit = groupRowsVisible();
    let shown = 0, hidden = 0, prev = null;

    const addRow = (opts) => {
      const li = document.createElement('li');
      li.className = 'group-row' + (opts.pinned ? ' is-pinned' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = opts.pinned;
      cb.title = opts.pinned ? 'Quitar el pin' : 'Poner un pin aquí';
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => opts.onToggle(cb.checked));
      const meta = document.createElement('div');
      meta.className = 'group-meta';
      meta.innerHTML = `<div class="group-title">${escapeHtml(opts.title)}</div>
        <div class="group-sub">${escapeHtml(opts.sub)}</div>`;
      li.appendChild(cb);
      li.appendChild(meta);
      li.addEventListener('click', () => {
        if (state.map) state.map.easeTo({ center: [opts.lng, opts.lat], zoom: Math.max(state.map.getZoom(), 14) });
      });
      ul.appendChild(li);
    };

    if (mode === 'photos') {
      /* Todas las fotos del viaje, una por fila, para poder marcar a mano
         cualquiera y no solo la representante que eligió el automático. */
      const list = photos.filter((r) => r.lat != null && r.takenAt != null)
        .sort((a, b) => a.takenAt - b.takenAt);
      for (const r of list) {
        const isPin = (r.idx != null && pinned.has('k:' + r.idx)) || (r.name && pinned.has('n:' + r.name));
        const dist = prev ? Trips.haversine(prev.lat, prev.lng, r.lat, r.lng) * 1000 : 0;
        prev = r;
        if (onlyPinned && !isPin) continue;
        if (shown >= limit) { hidden++; continue; }
        shown++;
        const bits = [];
        if (dist) bits.push(`a ${fmtDist(dist)} de la anterior`);
        if (isPin) {
          const pin = findPinFor(r);
          if (pin) bits.push(['principal', 'secundario', 'terciario'][(pin.tier || 1) - 1]);
        }
        addRow({
          pinned: isPin, lat: r.lat, lng: r.lng,
          title: `${fmtClock(r.takenAt)} · ${r.name || ''}`.slice(0, 48),
          sub: bits.join(' · ') || 'sin pin',
          onToggle: (on) => togglePhotoPin(r, on)
        });
      }
    } else {
      for (const g of state.groups) {
        const pins = groupPins(g, pinned);
        const dist = prev ? Trips.haversine(prev.lat, prev.lng, g.lat, g.lng) * 1000 : 0;
        prev = g;
        if (onlyPinned && !pins.length) continue;
        if (shown >= limit) { hidden++; continue; }
        shown++;
        const bits = [`${fmtInt(g.count)} foto${g.count === 1 ? '' : 's'}`];
        if (g.minutes >= 5) bits.push(`${g.minutes >= 90 ? (g.minutes / 60).toFixed(1) + ' h' : g.minutes + ' min'}`);
        if (dist) bits.push(`a ${fmtDist(dist)} de la anterior`);
        // Al subir la distancia de agrupación varios pines acaban dentro de la
        // misma parada; sin decirlo, desmarcar una parecería borrar de más.
        if (pins.length > 1) bits.push(`${pins.length} pines aquí`);
        addRow({
          pinned: pins.length > 0, lat: g.lat, lng: g.lng,
          title: fmtClock(g.start), sub: bits.join(' · '),
          onToggle: (on) => toggleGroupPin(g, on)
        });
      }
    }

    renderOverlapHint();

    if (!shown) {
      const li = document.createElement('li');
      li.className = 'empty tiny muted';
      li.textContent = onlyPinned ? 'Nada con pin todavía.' : 'Nada que listar con estos ajustes.';
      ul.appendChild(li);
    } else if (hidden) {
      const li = document.createElement('li');
      li.className = 'empty';
      const btn = document.createElement('button');
      btn.className = 'btn tiny ghost';
      btn.textContent = `Mostrar ${Math.min(hidden, MAX_GROUP_ROWS)} más (quedan ${fmtInt(hidden)})`;
      btn.addEventListener('click', () => {
        state.groupLimit = limit + MAX_GROUP_ROWS;
        renderGroups();
      });
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  function findPinFor(rec) {
    return state.photos.find((p) =>
      (rec.idx != null && p.scanIdx === rec.idx) || (rec.name && p.name === rec.name));
  }

  async function togglePhotoPin(rec, on) {
    if (on) {
      const p = Photos.fromScan(rec, state.mapDoc.id);
      p.order = state.photos.length;
      state.photos.push(p);
      await savePhoto(p);
    } else {
      const hit = findPinFor(rec);
      if (hit) await deletePhotoById(hit.id);
    }
    renderLists();
    syncMarkers();
    syncRoute();
    renderGroups();
  }

  /* Reparte los pines existentes en tres niveles según el peso de su parada:
     los más importantes grandes, los del medio medianos y el resto solo como
     punto. Es la forma rápida de que un póster con muchos pines se lea. */
  async function autoTiers() {
    if (!state.photos.length) { banner('No hay pines que escalonar.', 'info'); return; }
    const pinned = pinnedKeySet();
    const withWeight = state.groups
      .filter((g) => groupPins(g, pinned).length)
      .sort((a, b) => (b.count + b.minutes / 30) - (a.count + a.minutes / 30));

    const n = withWeight.length || 1;
    let changed = 0;
    for (let i = 0; i < withWeight.length; i++) {
      const tier = i < Math.ceil(n / 3) ? 1 : i < Math.ceil((2 * n) / 3) ? 2 : 3;
      for (const r of groupPins(withWeight[i], pinned)) {
        const pin = findPinFor(r);
        if (pin && pin.tier !== tier) { pin.tier = tier; await savePhoto(pin); changed++; }
      }
    }
    renderLists();
    syncMarkers();
    renderGroups();
    banner(changed ? `${changed} pines escalonados en principal, secundario y terciario.`
                   : 'Los niveles ya estaban repartidos.', 'ok');
  }

  /* Recupera la lista de fotos del viaje para un mapa antiguo: busca en la
     biblioteca el viaje cuyas fechas más se solapan con las de sus pines. */
  async function rebuildTripPhotos() {
    const times = state.photos.filter((p) => p.takenAt).map((p) => p.takenAt);
    if (!times.length || !state.library) {
      banner('Necesito la biblioteca escaneada y pines con fecha para reconstruir las paradas.', 'warn');
      return;
    }
    busy(true, 'Buscando el viaje en la biblioteca…');
    try {
      const lo = Math.min(...times), hi = Math.max(...times);
      let best = null, bestOverlap = 0;
      for (const t of Trips.detect(state.library.records, tripOptions())) {
        const ov = Math.min(hi, t.end) - Math.max(lo, t.start);
        if (ov > bestOverlap) { bestOverlap = ov; best = t; }
      }
      if (!best) {
        banner('Ningún viaje de la biblioteca coincide con las fechas de este mapa. Vuelve a escanear las fotos de ese viaje.', 'warn', true);
        return;
      }
      state.mapDoc.tripPhotos = best.photos.map(tripPhotoRecord);
      const pts = best.photos.filter((r) => r.lat != null).map((r) => [r.lng, r.lat]);
      state.mapDoc.track = pts.length > TRACK_MAX_POINTS ? Trips.simplify(pts) : pts;
      await DB.putMap(state.mapDoc);
      syncTrack();
      banner(`Paradas reconstruidas desde ${fmtInt(best.photos.length)} fotos del viaje.`, 'ok');
    } finally {
      busy(false);
    }
    renderGroups();
  }

  async function toggleGroupPin(group, on) {
    const pinned = pinnedKeySet();
    if (on) {
      const rec = Photos.fromScan(group.rep, state.mapDoc.id);
      rec.order = state.photos.length;
      state.photos.push(rec);
      await savePhoto(rec);
    } else {
      for (const r of groupPins(group, pinned)) {
        const hit = state.photos.find((p) =>
          (r.idx != null && p.scanIdx === r.idx) || (r.name && p.name === r.name));
        if (hit) await deletePhotoById(hit.id);
      }
    }
    renderLists();
    syncMarkers();
    syncRoute();
    renderGroups();
  }

  async function pinTopGroups(n) {
    if (!state.groups.length) return;
    if (state.photos.length && !confirm(
      `Esto sustituye los ${state.photos.length} pines actuales por las ${n} paradas con más peso. ¿Seguir?`)) return;
    busy(true, 'Marcando paradas…');
    try {
      for (const p of state.photos.slice()) await deletePhotoById(p.id);
      const top = Trips.rankGroups(state.groups, n);
      for (let i = 0; i < top.length; i++) {
        const rec = Photos.fromScan(top[i].rep, state.mapDoc.id);
        rec.order = i;
        state.photos.push(rec);
        await savePhoto(rec);
      }
      banner(`${top.length} paradas marcadas como pin de ${fmtInt(state.groups.length)}.`, 'ok');
    } finally {
      busy(false);
    }
    renderLists();
    syncMarkers();
    syncRoute();
    renderGroups();
  }

  async function unpinAll() {
    if (!state.photos.length) return;
    if (!confirm(`¿Quitar los ${state.photos.length} pines del mapa? La traza del recorrido no se toca.`)) return;
    busy(true, 'Quitando pines…');
    try {
      for (const p of state.photos.slice()) await deletePhotoById(p.id);
    } finally {
      busy(false);
    }
    renderLists();
    syncMarkers();
    syncRoute();
    renderGroups();
  }

  /* ---------------- píxeles bajo demanda ---------------- */

  function heicChoice() { return localStorage.getItem('fr:heic'); }

  function askHeic() {
    return new Promise((resolve) => {
      const dlg = $('heicDlg');
      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        const ok = dlg.returnValue === 'ok';
        if ($('heicRemember').checked) {
          localStorage.setItem('fr:heic', ok ? 'on' : 'off');
          $('heicMode').value = ok ? 'on' : 'off';
        }
        resolve(ok);
      };
      dlg.addEventListener('close', onClose);
      dlg.showModal();
    });
  }

  async function loadPixels(photos) {
    const pending = photos.filter((p) => !p.thumb);
    if (!pending.length) { banner('Todos los pines ya tienen su imagen.', 'ok'); return; }

    const missing = pending.filter((p) => p.scanIdx == null || !state.fileRefs.has(p.scanIdx));
    const doable = pending.filter((p) => p.scanIdx != null && state.fileRefs.has(p.scanIdx));
    if (!doable.length) {
      banner('Los archivos originales ya no están en esta sesión. Vuelve a escanear la carpeta y podré cargar las imágenes.', 'warn', true);
      return;
    }

    const needsHeic = doable.some((p) => Scan.kindOf(state.fileRefs.get(p.scanIdx)) === 'heic');
    if (needsHeic) {
      let choice = heicChoice();
      if (choice !== 'on' && choice !== 'off') choice = (await askHeic()) ? 'on' : 'off';
      if (choice !== 'on') {
        banner('Sigo sin imágenes: los pines HEIC se quedan como gota o número.', 'info');
        return;
      }
    }

    busy(true, 'Cargando imágenes…');
    let done = 0, failed = 0;
    try {
      for (const p of doable) {
        const file = state.fileRefs.get(p.scanIdx);
        $('busyText').textContent = `Cargando imágenes… ${done + 1} / ${doable.length}`;
        try {
          await Photos.attachPixels(p, file);
          await savePhoto(p);
          state.thumbImgs.delete(p.id);
          state.thumbUrls.delete(p.id);
          done++;
        } catch (e) {
          failed++;
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      busy(false);
    }
    renderLists();
    syncMarkers();
    if (state.selectedId) select(state.selectedId);
    const parts = [`${done} imágenes cargadas`];
    if (failed) parts.push(`${failed} fallaron`);
    if (missing.length) parts.push(`${missing.length} sin archivo en esta sesión`);
    banner(parts.join(' · '), failed ? 'warn' : 'ok');
  }

  /* ---------------- pestañas ---------------- */

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
    $('tabLib').hidden = name !== 'lib';
    $('tabMap').hidden = name !== 'map';
  }

  /* ---------------- overlay (vista previa) ---------------- */
  function updateOverlay() {
    const s = state.mapDoc.settings;
    const t = theme();
    const st = $('stage');
    st.style.setProperty('--title', t.title);
    st.style.setProperty('--sub', t.sub);
    st.style.setProperty('--dim', t.dim);
    st.style.setProperty('--bg', t.bg);
    st.style.setProperty('--accent', t.accent);

    // Mismo layout que usa el exportador, traducido a variables CSS: una sola
    // fuente de verdad para que mover o agrandar un texto se vea igual aquí
    // que en la imagen descargada.
    const lay = Exporter.layoutFor(s, s.title, s.subtitle);
    // Si el tamaño pedido no cabe, el control lo dice en vez de dejar que el
    // usuario siga subiendo un deslizador que ya no hace nada.
    const capNote = (id, capped) => {
      const el = $(id);
      if (el) el.textContent = el.textContent.replace(/ · al máximo$/, '') + (capped ? ' · al máximo' : '');
    };
    capNote('inTitleScaleVal', lay.titleCapped);
    capNote('inSubScaleVal', lay.subCapped);
    st.style.setProperty('--title-base', lay.titleBase);
    st.style.setProperty('--title-size', lay.titleSize);
    st.style.setProperty('--rule-y', lay.ruleY);
    st.style.setProperty('--sub-base', lay.subBase);
    st.style.setProperty('--sub-size', lay.subSize);
    st.style.setProperty('--coords-base', lay.coordsBase);
    st.style.setProperty('--dist-base', lay.distBase);
    st.style.setProperty('--legend-base', lay.legendBase);
    st.style.setProperty('--text-align', lay.align);
    st.style.setProperty('--text-pad', lay.pad + 'cqw');

    const ov = $('overlay');
    ov.classList.toggle('align-left', lay.align === 'left');
    ov.classList.toggle('align-right', lay.align === 'right');

    $('ovTitle').textContent = (s.title || '').toUpperCase();
    $('ovTitle').hidden = !s.title;
    $('ovRule').hidden = !s.title;
    $('ovSubtitle').textContent = (s.subtitle || '').toUpperCase();
    $('ovSubtitle').hidden = !s.subtitle;

    const leg = $('ovLegend');
    const items = s.showLegend ? legendItems() : [];
    leg.hidden = !items.length;
    leg.innerHTML = items
      .map((t, i) => `<div><b>${String(i + 1).padStart(2, '0')}</b>${escapeHtml(t)}</div>`)
      .join('');

    if (state.map && s.showCoords) {
      const c = state.map.getCenter();
      $('ovCoords').textContent = Exporter.fmtCoords(c.lat, c.lng);
    }
    $('ovCoords').hidden = !s.showCoords;

    const dist = s.showDistance ? travelLine() : '';
    $('ovDistance').textContent = dist;
    $('ovDistance').hidden = !dist;
    $('ovBrand').hidden = !s.showFooter;
  }

  function applyAspect() {
    const s = state.mapDoc.settings;
    const [w, h] = s.aspect.split(':').map(Number);
    $('stage').style.aspectRatio = `${w} / ${h}`;
    requestAnimationFrame(() => {
      if (state.map) state.map.resize();
      syncMarkers();
    });
  }

  /* ---------------- listas ---------------- */
  function photoRow(p, index) {
    const li = document.createElement('li');
    li.className = 'photo-row' + (p.id === state.selectedId ? ' is-selected' : '');
    li.dataset.id = p.id;

    const im = document.createElement('img');
    im.src = thumbOrPlaceholder(p);
    im.alt = '';
    im.className = 'row-thumb';
    im.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(p.id); });

    const meta = document.createElement('div');
    meta.className = 'row-meta';
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = p.caption || p.name || 'Sin nombre';
    const sub = document.createElement('div');
    sub.className = 'row-sub';
    const bits = [];
    if (index != null) bits.push('#' + (index + 1));
    if (p.takenAt) bits.push(new Date(p.takenAt).toLocaleDateString('es', { day: '2-digit', month: 'short', year: '2-digit' }));
    bits.push(p.lat == null ? 'sin ubicación' : (p.fromExif ? 'GPS de la foto' : 'ubicada a mano'));
    sub.textContent = bits.join(' · ');
    meta.appendChild(title);
    meta.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (p.lat == null) {
      const b = document.createElement('button');
      b.className = 'btn tiny primary';
      b.textContent = 'Colocar';
      b.addEventListener('click', (e) => { e.stopPropagation(); select(p.id); setPlacing(p.id); $('unplacedHelp').hidden = false; });
      actions.appendChild(b);
    } else {
      /* Botón que cicla el nivel en vez de un desplegable: en modo de orden
         manual la fila ya lleva cinco controles y un select ocupaba tanto que
         se comía el sitio donde se pulsa para seleccionar la foto. */
      const tier = document.createElement('button');
      tier.className = 'btn tiny ghost tier-btn';
      const paint = () => {
        tier.textContent = ['①', '②', '③'][(p.tier || 1) - 1];
        tier.title = 'Nivel: ' + ['principal (grande)', 'secundario (mediano)', 'terciario (solo el punto)'][(p.tier || 1) - 1]
          + ' — pulsa para cambiar';
      };
      paint();
      tier.addEventListener('click', (e) => {
        e.stopPropagation();
        p.tier = ((p.tier || 1) % 3) + 1;
        paint();
        savePhoto(p);
        syncMarkers();
        renderGroups();
      });
      actions.appendChild(tier);

      const b = document.createElement('button');
      b.className = 'btn tiny ghost';
      b.textContent = 'Centrar';
      b.addEventListener('click', (e) => { e.stopPropagation(); state.map.easeTo({ center: [p.lng, p.lat] }); select(p.id); });
      actions.appendChild(b);
      if (state.mapDoc.settings.orderMode === 'manual') {
        const up = document.createElement('button');
        up.className = 'btn tiny ghost';
        up.textContent = '↑';
        up.addEventListener('click', (e) => { e.stopPropagation(); move(p.id, -1); });
        const dn = document.createElement('button');
        dn.className = 'btn tiny ghost';
        dn.textContent = '↓';
        dn.addEventListener('click', (e) => { e.stopPropagation(); move(p.id, 1); });
        actions.appendChild(up);
        actions.appendChild(dn);
      }
    }
    const del = document.createElement('button');
    del.className = 'btn tiny ghost danger';
    del.textContent = '×';
    del.title = 'Eliminar foto';
    del.addEventListener('click', (e) => { e.stopPropagation(); removePhoto(p.id); });
    actions.appendChild(del);

    li.appendChild(im);
    li.appendChild(meta);
    li.appendChild(actions);
    li.addEventListener('click', () => select(p.id));
    return li;
  }

  function move(id, dir) {
    const list = ordered();
    const i = list.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
    list.forEach((p, k) => { p.order = k; savePhoto(p); });
    renderLists();
    syncMarkers();
    syncRoute();
  }

  function renderLists() {
    const un = unplaced();
    const pl = ordered();
    $('photoCount').textContent = state.photos.length;
    $('unplacedCount').textContent = un.length;
    $('placedCount').textContent = pl.length;
    $('unplacedHelp').hidden = un.length === 0;

    const ul = $('unplacedList');
    ul.innerHTML = '';
    un.forEach((p) => ul.appendChild(photoRow(p, null)));
    if (!un.length) {
      const li = document.createElement('li');
      li.className = 'empty tiny muted';
      li.textContent = state.photos.length ? 'Todas tus fotos están ubicadas.' : '—';
      ul.appendChild(li);
    }

    $('thumbRow').hidden = !pl.some((p) => !p.thumb);

    const pls = $('placedList');
    pls.innerHTML = '';
    pl.forEach((p, i) => pls.appendChild(photoRow(p, i)));
    if (!pl.length) {
      const li = document.createElement('li');
      li.className = 'empty tiny muted';
      li.textContent = 'Ninguna foto en el mapa todavía.';
      pls.appendChild(li);
    }
  }

  /* ---------------- selección ---------------- */
  function select(id) {
    state.selectedId = id;
    const p = state.photos.find((x) => x.id === id);
    if (p) fillSelection(p); else clearSelection();
    document.querySelectorAll('.photo-row').forEach((el) => {
      el.classList.toggle('is-selected', el.dataset.id === id);
    });
    state.markers.forEach((m, pid) => {
      m.getElement().classList.toggle('is-selected', pid === id);
    });
  }

  function clearSelection() {
    state.selectedId = null;
    $('selPanel').hidden = true;
    $('selEmpty').hidden = false;
    $('selNoImg').hidden = true;
  }

  function fillSelection(p) {
    $('selPanel').hidden = false;
    $('selEmpty').hidden = true;
    $('selThumb').src = thumbOrPlaceholder(p);
    $('selCaption').value = p.caption || '';
    $('selTier').value = String(p.tier || 1);
    $('selLat').value = p.lat != null ? p.lat.toFixed(6) : '';
    $('selLng').value = p.lng != null ? p.lng.toFixed(6) : '';
    $('selDate').value = p.takenAt ? toLocalInput(p.takenAt) : '';

    const canLoad = !p.thumb && p.scanIdx != null && state.fileRefs.has(p.scanIdx);
    $('selLoadImg').hidden = !canLoad;
    const noImg = $('selNoImg');
    if (p.thumb) {
      noImg.hidden = true;
    } else if (canLoad) {
      noImg.hidden = false;
      noImg.textContent = 'Todavía no se cargó la imagen de esta foto.';
    } else {
      noImg.hidden = false;
      noImg.textContent = 'No tengo el archivo original en esta sesión (se perdió al recargar la página). '
        + 'Vuelve a escanear la misma carpeta en «Biblioteca»: si esta foto sigue ahí, la reconecto por su nombre.';
    }
  }

  function toLocalInput(ms) {
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  }

  /* Borra sin preguntar ni repintar: lo usan tanto el botón de eliminar como
     las acciones en bloque de las paradas, que repintan una sola vez al final. */
  async function deletePhotoById(id) {
    await DB.deletePhoto(id);
    state.photos = state.photos.filter((x) => x.id !== id);
    if (state.thumbUrls.has(id)) { URL.revokeObjectURL(state.thumbUrls.get(id)); state.thumbUrls.delete(id); }
    if (state.displayUrls.has(id)) { URL.revokeObjectURL(state.displayUrls.get(id)); state.displayUrls.delete(id); }
    state.thumbImgs.delete(id);
    if (state.selectedId === id) clearSelection();
  }

  async function removePhoto(id) {
    const p = state.photos.find((x) => x.id === id);
    if (!p) return;
    if (!confirm(`¿Eliminar «${p.caption || p.name}» de este mapa?`)) return;
    await deletePhotoById(id);
    renderLists();
    syncMarkers();
    syncRoute();
    renderGroups();
  }

  /* ---------------- ingesta ---------------- */
  async function ingestFiles(fileList) {
    const files = [...fileList].filter((f) => {
      const k = Scan.kindOf(f);
      return k !== 'video' && k !== 'otro';
    });
    if (!files.length) { banner('No reconocí ninguna imagen en lo que soltaste.', 'warn'); return; }

    // Decodificar HEIC exige el decodificador wasm: se pregunta una sola vez y
    // si el usuario dice que no, las fotos entran igual pero sin imagen.
    let heicPixels = false;
    if (files.some((f) => Scan.kindOf(f) === 'heic')) {
      let choice = heicChoice();
      if (choice !== 'on' && choice !== 'off') choice = (await askHeic()) ? 'on' : 'off';
      heicPixels = choice === 'on';
    }

    const prog = $('ingestProgress');
    const bar = prog.querySelector('.bar');
    const label = prog.querySelector('span');
    prog.hidden = false;

    let withGps = 0, noPixels = 0, full = 0;
    for (let i = 0; i < files.length; i++) {
      label.textContent = `${i + 1} / ${files.length}`;
      bar.style.width = ((i / files.length) * 100).toFixed(1) + '%';
      await new Promise((r) => requestAnimationFrame(r));

      const wantPixels = Scan.kindOf(files[i]) !== 'heic' || heicPixels;
      let rec;
      try {
        rec = await Photos.ingest(files[i], state.mapDoc.id, { pixels: wantPixels });
      } catch (e) {
        noPixels++;
        continue;
      }
      if (rec.lat != null) withGps++;
      if (rec.thumb) full++; else noPixels++;
      rec.order = state.photos.length;
      state.photos.push(rec);
      // el archivo queda accesible por si luego se piden las imágenes
      rec.scanIdx = 'drop_' + rec.id;
      state.fileRefs.set(rec.scanIdx, files[i]);
      try {
        await savePhoto(rec);
      } catch (e) {
        banner('El navegador se quedó sin espacio para guardar. Exporta el proyecto y libera fotos.', 'warn', true);
        break;
      }
    }
    bar.style.width = '100%';
    prog.hidden = true;

    renderLists();
    syncMarkers();
    syncRoute();
    renderGroups();
    if (withGps) fitAll();

    const parts = [`${state.photos.length} fotos en el mapa`, `${withGps} con GPS`];
    const noGps = files.length - withGps;
    if (noGps > 0) parts.push(`${noGps} sin ubicación (colócalas a mano)`);
    if (noPixels) parts.push(`${noPixels} sin imagen cargada`);
    banner(parts.join(' · '), noPixels ? 'warn' : 'ok');

    if (!state.mapDoc.settings.subtitle && withGps) {
      const first = placed()[0];
      if (first) {
        const name = await Geocode.reverse(first.lat, first.lng);
        if (name && !state.mapDoc.settings.subtitle) {
          state.mapDoc.settings.subtitle = name;
          $('inSubtitle').value = name;
          updateOverlay();
          saveMapSoon();
        }
      }
    }
  }

  /* ---------------- CRUD de mapas ---------------- */
  async function loadMaps(preferId) {
    state.maps = await DB.allMaps();
    if (!state.maps.length) {
      const doc = { id: 'm_' + Date.now().toString(36), name: 'Mi primer recorrido', settings: defaultSettings(), createdAt: Date.now() };
      await DB.putMap(doc);
      state.maps = [doc];
    }
    const sel = $('mapSelect');
    sel.innerHTML = '';
    state.maps.forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name;
      sel.appendChild(o);
    });
    const id = preferId && state.maps.some((m) => m.id === preferId) ? preferId : state.maps[0].id;
    sel.value = id;
    return id;
  }

  async function openMap(id) {
    releaseUrls();
    state.mapDoc = await DB.getMap(id);
    state.mapDoc.settings = Object.assign(defaultSettings(), state.mapDoc.settings || {});
    state.photos = await DB.photosOf(id);
    state.selectedId = null;
    clearSelection();

    bindSettingsToUI();
    applyAspect();
    updateOverlay();
    renderLists();
    renderGroups();

    if (!state.map) {
      initMap();
    } else {
      const s = state.mapDoc.settings;
      state.map.jumpTo({ center: s.center, zoom: s.zoom, bearing: s.bearing });
      MapView.applyTheme(state.map, theme(), s.showLabels);
      syncTrack();
      syncMarkers();
      syncRoute();
    }
    localStorage.setItem('fr:lastMap', id);
  }

  function bindSettingsToUI() {
    const s = state.mapDoc.settings;
    $('inTitle').value = s.title || '';
    $('inSubtitle').value = s.subtitle || '';
    $('inAspect').value = s.aspect;
    $('inPinStyle').value = s.pinStyle;
    $('inPinSize').value = s.pinSize;
    $('inTrack').checked = !!s.showTrack;
    $('inRoute').checked = !!s.showRoute;
    $('inRouteDashed').checked = !!s.routeDashed;
    $('inLabels').checked = !!s.showLabels;
    $('inCoords').checked = !!s.showCoords;
    $('inFooter').checked = !!s.showFooter;
    $('inLegend').checked = !!s.showLegend;
    $('inTrackByMode').checked = !!s.trackByMode;
    $('inShowDistance').checked = !!s.showDistance;
    $('orderMode').value = s.orderMode;
    $('groupRadius').value = radiusIndex(s.groupRadiusM || 350);
    $('groupRadiusVal').textContent = fmtDist(s.groupRadiusM || 350);

    const setRange = (id, v) => { $(id).value = v; if ($(id + 'Val')) $(id + 'Val').textContent = v; };
    setRange('inRouteWidth', s.routeWidth ?? 2.4);
    setRange('inRouteDashLen', s.routeDashLen ?? 4);
    setRange('inRouteGapLen', s.routeGapLen ?? 4);
    setRange('inRouteOpacity', Math.round((s.routeOpacity ?? 1) * 100));
    setRange('inTrackWidth', s.trackWidth ?? 1.2);
    setRange('inTrackOpacity', Math.round((s.trackOpacity ?? 0.3) * 100));
    setRange('inTrackDot', s.trackDotSize ?? 1.3);
    setRange('inTextY', s.textY ?? 0);
    setRange('inTitleScale', Math.round((s.titleScale ?? 1) * 100));
    setRange('inSubScale', Math.round((s.subScale ?? 1) * 100));
    $('inRouteGlow').checked = s.routeGlow !== false;
    $('inTextAlign').value = s.textAlign || 'center';
    document.querySelectorAll('#themeGrid .swatch').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.theme === s.theme);
    });
  }

  function buildThemeGrid() {
    const grid = $('themeGrid');
    grid.innerHTML = '';
    Object.entries(window.THEMES).forEach(([key, t]) => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.dataset.theme = key;
      b.title = t.label;
      b.innerHTML = `
        <span class="sw-preview" style="background:${t.bg}">
          <i style="background:${t.building}"></i>
          <i style="background:${t.roadMajor}"></i>
          <i style="background:${t.accent}"></i>
        </span>
        <span class="sw-label">${t.label}</span>`;
      b.addEventListener('click', () => {
        state.mapDoc.settings.theme = key;
        bindSettingsToUI();
        MapView.applyTheme(state.map, theme(), state.mapDoc.settings.showLabels);
        syncTrack();
        syncRoute();
        syncMarkers();
        updateOverlay();
        saveMapSoon();
      });
      grid.appendChild(b);
    });
  }

  /* ---------------- lightbox ---------------- */
  function openLightbox(id) {
    const list = state.photos;
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) return;
    state.lbIndex = i;
    const p = list[i];
    $('lbImg').src = displayUrl(p);
    $('lbCaption').textContent = p.caption || p.name || '';
    $('lightbox').hidden = false;
  }
  function stepLightbox(d) {
    if (state.lbIndex < 0) return;
    const n = state.photos.length;
    state.lbIndex = (state.lbIndex + d + n) % n;
    openLightbox(state.photos[state.lbIndex].id);
  }

  /* ---------------- exportar / importar proyecto ---------------- */
  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function blobToDataUrl(b) {
    return new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(b);
    });
  }

  async function exportProject() {
    busy(true, 'Empaquetando proyecto…');
    try {
      const photos = [];
      for (const p of state.photos) {
        photos.push({
          name: p.name, caption: p.caption, lat: p.lat, lng: p.lng,
          fromExif: p.fromExif, takenAt: p.takenAt, order: p.order,
          width: p.width, height: p.height, kind: p.kind || null,
          data: p.display ? await blobToDataUrl(p.display) : null
        });
      }
      const doc = {
        format: 'fotos-recorrido',
        version: 1,
        name: state.mapDoc.name,
        settings: state.mapDoc.settings,
        track: state.mapDoc.track || [],
        tripPhotos: state.mapDoc.tripPhotos || [],
        photos
      };
      const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' });
      download(blob, slug(state.mapDoc.name) + '.frmap.json');
    } finally {
      busy(false);
    }
  }

  async function importProject(file) {
    busy(true, 'Importando…');
    try {
      const doc = JSON.parse(await file.text());
      if (doc.format !== 'fotos-recorrido') throw new Error('formato');
      const id = 'm_' + Date.now().toString(36);
      const mapDoc = {
        id,
        name: (doc.name || 'Importado') + ' (importado)',
        settings: Object.assign(defaultSettings(), doc.settings || {}),
        track: doc.track || [],
        tripPhotos: doc.tripPhotos || [],
        createdAt: Date.now()
      };
      await DB.putMap(mapDoc);
      for (const p of (doc.photos || [])) {
        if (!p.data) {
          // pin sin imagen: se conserva igual, el mapa lo necesita
          await DB.putPhoto({
            id: Photos.uid(), mapId: id, name: p.name || '', caption: p.caption || '',
            lat: p.lat ?? null, lng: p.lng ?? null, fromExif: !!p.fromExif,
            takenAt: p.takenAt ?? null, order: p.order ?? null, kind: p.kind || null,
            scanIdx: null, width: null, height: null, display: null, thumb: null
          });
          continue;
        }
        const blob = await (await fetch(p.data)).blob();
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        const sc = Math.min(1, 240 / Math.max(bmp.width, bmp.height));
        c.width = Math.round(bmp.width * sc);
        c.height = Math.round(bmp.height * sc);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        const thumb = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
        await DB.putPhoto({
          id: Photos.uid(), mapId: id, name: p.name || '', caption: p.caption || '',
          lat: p.lat ?? null, lng: p.lng ?? null, fromExif: !!p.fromExif,
          takenAt: p.takenAt ?? null, order: p.order ?? null, kind: p.kind || null,
          scanIdx: null, width: bmp.width, height: bmp.height, display: blob, thumb
        });
        if (bmp.close) bmp.close();
      }
      const chosen = await loadMaps(id);
      await openMap(chosen);
      banner('Proyecto importado.', 'ok');
    } catch (e) {
      banner('Ese archivo no es un proyecto de Fotos Recorrido.', 'warn');
    } finally {
      busy(false);
    }
  }

  function slug(s) {
    return (s || 'mapa').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mapa';
  }

  /* ---------------- exportar imagen ---------------- */
  function updateExportSize() {
    const base = window.ASPECTS[state.mapDoc.settings.aspect];
    const q = Number($('exQuality').value);
    $('exSize').textContent = `Resultado: ${Math.round(base.w * q)} × ${Math.round(base.h * q)} px`;
  }

  async function doExport() {
    const s = state.mapDoc.settings;
    const list = ordered();
    busy(true, 'Renderizando el póster… puede tardar unos segundos');
    try {
      const thumbs = {};
      if (s.pinStyle === 'photo') {
        for (const p of list) {
          const img = thumbImage(p);
          if (img && !img.complete) {
            await new Promise((r) => { img.onload = r; img.onerror = r; });
          }
          if (img && img.complete && img.naturalWidth) thumbs[p.id] = img;
        }
      }
      const cam = {
        center: [state.map.getCenter().lng, state.map.getCenter().lat],
        zoom: state.map.getZoom(),
        bearing: state.map.getBearing()
      };
      const res = await Exporter.render({
        aspect: s.aspect,
        quality: $('exQuality').value,
        format: $('exFormat').value,
        settings: s,
        photos: list,
        thumbs,
        routeCoords: list.map((p) => [p.lng, p.lat]),
        trackCoords: state.mapDoc.track || [],
        trackSegments: trackSegments(),
        distance: s.showDistance ? travelLine() : '',
        editorWidth: $('stage').clientWidth,
        camera: cam
      });
      if (!res.blob) throw new Error('blob');
      download(res.blob, `${slug(state.mapDoc.name)}-${res.width}x${res.height}.${$('exFormat').value === 'jpeg' ? 'jpg' : 'png'}`);
      banner(`Imagen lista: ${res.width} × ${res.height} px`, 'ok');
    } catch (e) {
      banner('No pude generar la imagen. Si el mapa no terminó de cargar, espera a que se vea completo y reintenta.', 'warn', true);
    } finally {
      busy(false);
    }
  }

  /* ---------------- eventos ---------------- */
  function wire() {
    // pestañas
    document.querySelectorAll('.tab').forEach((b) =>
      b.addEventListener('click', () => switchTab(b.dataset.tab)));

    // escaneo de la biblioteca
    $('btnScanFiles').addEventListener('click', () => $('scanInput').click());
    $('btnScanFolder').addEventListener('click', () => $('scanFolderInput').click());
    $('scanInput').addEventListener('change', (e) => { startScan(e.target.files); e.target.value = ''; });
    $('scanFolderInput').addEventListener('change', (e) => { startScan(e.target.files); e.target.value = ''; });
    $('btnScanCancel').addEventListener('click', () => { if (state.scan) state.scan.cancel(); });
    $('btnScanClear').addEventListener('click', async () => {
      if (!state.library || !state.library.records.length) return;
      if (!confirm('¿Vaciar la biblioteca escaneada? Los mapas y sus pines no se tocan; solo se olvida qué fotos había en el carrete y qué archivos quedan disponibles para cargar imágenes nuevas.')) return;
      state.library = null;
      state.fileRefs.clear();
      await DB.putLibrary({ id: LIB_ID, records: [], home: null, scannedAt: Date.now() });
      $('scanSummary').hidden = true;
      renderTrips();
    });
    $('tripIgnoreHome').addEventListener('change', renderTrips);
    $('tripGap').addEventListener('input', (e) => {
      $('tripGapVal').textContent = e.target.value;
    });
    $('tripGap').addEventListener('change', renderTrips);
    $('tripMinHours').addEventListener('input', (e) => {
      $('tripMinHoursVal').textContent = e.target.value;
    });
    $('tripMinHours').addEventListener('change', renderTrips);
    $('btnLoadThumbs').addEventListener('click', () => loadPixels(placed()));

    /* Deslizador -> ajuste del mapa. scale convierte lo que ve el usuario
       (por ejemplo 100 %) en lo que guarda el ajuste (1). */
    const bindRange = (id, key, after, scale) => {
      const el = $(id), out = $(id + 'Val');
      const show = (v) => { if (out) out.textContent = v; };
      el.addEventListener('input', (e) => {
        show(e.target.value);
        state.mapDoc.settings[key] = scale ? scale(Number(e.target.value)) : Number(e.target.value);
        if (after) after();
      });
      el.addEventListener('change', saveMapSoon);
    };
    const pct = (v) => v / 100;

    bindRange('inRouteWidth', 'routeWidth', syncRoute);
    bindRange('inRouteDashLen', 'routeDashLen', syncRoute);
    bindRange('inRouteGapLen', 'routeGapLen', syncRoute);
    bindRange('inRouteOpacity', 'routeOpacity', syncRoute, pct);
    bindRange('inTrackWidth', 'trackWidth', syncTrack);
    bindRange('inTrackOpacity', 'trackOpacity', syncTrack, pct);
    bindRange('inTrackDot', 'trackDotSize', syncTrack);
    bindRange('inTextY', 'textY', updateOverlay);
    bindRange('inTitleScale', 'titleScale', updateOverlay, pct);
    bindRange('inSubScale', 'subScale', updateOverlay, pct);
    // listener explícito: bindCheck se declara más abajo con const y usarlo
    // aquí rompía todo el cableado posterior por zona muerta temporal
    $('inRouteGlow').addEventListener('change', (e) => {
      state.mapDoc.settings.routeGlow = e.target.checked;
      syncRoute();
      saveMapSoon();
    });
    $('inTextAlign').addEventListener('change', (e) => {
      state.mapDoc.settings.textAlign = e.target.value;
      updateOverlay();
      saveMapSoon();
    });

    // nivel del pin seleccionado
    $('selTier').addEventListener('change', (e) => {
      const p = state.photos.find((x) => x.id === state.selectedId);
      if (!p) return;
      p.tier = Number(e.target.value) || 1;
      savePhoto(p);
      renderLists();
      syncMarkers();
    });

    // paradas
    $('groupRadius').addEventListener('input', (e) => {
      $('groupRadiusVal').textContent = fmtDist(GROUP_RADII[Number(e.target.value)]);
    });
    $('groupRadius').addEventListener('change', (e) => {
      state.mapDoc.settings.groupRadiusM = GROUP_RADII[Number(e.target.value)];
      saveMapSoon();
      renderGroups();
    });
    $('groupOnlyPinned').addEventListener('change', renderGroups);
    $('btnPinTop').addEventListener('click', () => pinTopGroups(SUGGESTED_PINS));
    $('btnPinNone').addEventListener('click', unpinAll);
    $('groupMode').addEventListener('change', renderGroups);
    $('btnTierAuto').addEventListener('click', autoTiers);
    $('btnRebuildTrip').addEventListener('click', rebuildTripPhotos);
    $('heicMode').value = heicChoice() || '';
    $('heicMode').addEventListener('change', (e) => {
      if (e.target.value) localStorage.setItem('fr:heic', e.target.value);
      else localStorage.removeItem('fr:heic');
    });
    $('selLoadImg').addEventListener('click', () => {
      const p = state.photos.find((x) => x.id === state.selectedId);
      if (p) loadPixels([p]);
    });

    // ingesta
    $('btnPick').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => { ingestFiles(e.target.files); e.target.value = ''; });

    const dz = $('dropzone');
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.remove('is-over');
    }));
    dz.addEventListener('drop', (e) => ingestFiles(e.dataTransfer.files));
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files.length) ingestFiles(e.dataTransfer.files);
    });

    // ajustes
    const bindText = (el, key) => $(el).addEventListener('input', (e) => {
      state.mapDoc.settings[key] = e.target.value;
      updateOverlay();
      saveMapSoon();
    });
    bindText('inTitle', 'title');
    bindText('inSubtitle', 'subtitle');

    $('inAspect').addEventListener('change', (e) => {
      state.mapDoc.settings.aspect = e.target.value;
      applyAspect();
      saveMapSoon();
    });
    $('inPinStyle').addEventListener('change', (e) => {
      state.mapDoc.settings.pinStyle = e.target.value;
      syncMarkers();
      saveMapSoon();
    });
    $('inPinSize').addEventListener('input', (e) => {
      state.mapDoc.settings.pinSize = Number(e.target.value);
      syncMarkers();
      saveMapSoon();
    });
    const bindCheck = (el, key, after) => $(el).addEventListener('change', (e) => {
      state.mapDoc.settings[key] = e.target.checked;
      if (after) after();
      saveMapSoon();
    });
    bindCheck('inTrack', 'showTrack', syncTrack);
    bindCheck('inRoute', 'showRoute', syncRoute);
    bindCheck('inRouteDashed', 'routeDashed', syncRoute);
    bindCheck('inLabels', 'showLabels', () => MapView.applyTheme(state.map, theme(), state.mapDoc.settings.showLabels));
    bindCheck('inCoords', 'showCoords', updateOverlay);
    bindCheck('inFooter', 'showFooter', updateOverlay);
    bindCheck('inLegend', 'showLegend', updateOverlay);
    bindCheck('inTrackByMode', 'trackByMode', syncTrack);
    bindCheck('inShowDistance', 'showDistance', updateOverlay);
    $('orderMode').addEventListener('change', (e) => {
      state.mapDoc.settings.orderMode = e.target.value;
      if (e.target.value === 'manual') reindexManual();
      renderLists();
      syncMarkers();
      syncRoute();
      saveMapSoon();
    });

    // foto seleccionada
    $('selCaption').addEventListener('input', (e) => {
      const p = state.photos.find((x) => x.id === state.selectedId);
      if (!p) return;
      p.caption = e.target.value;
      savePhoto(p);
      renderLists();
      updateOverlay();
    });
    const coordInput = () => {
      const p = state.photos.find((x) => x.id === state.selectedId);
      if (!p) return;
      const la = parseFloat($('selLat').value), ln = parseFloat($('selLng').value);
      if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
      if (la < -90 || la > 90 || ln < -180 || ln > 180) { banner('Coordenadas fuera de rango.', 'warn'); return; }
      p.lat = la; p.lng = ln; p.fromExif = false;
      if (p.order == null) p.order = placed().length;
      savePhoto(p);
      renderLists();
      syncMarkers();
      syncRoute();
    };
    $('selLat').addEventListener('change', coordInput);
    $('selLng').addEventListener('change', coordInput);
    $('selDate').addEventListener('change', (e) => {
      const p = state.photos.find((x) => x.id === state.selectedId);
      if (!p) return;
      const ms = new Date(e.target.value).getTime();
      p.takenAt = Number.isFinite(ms) ? ms : null;
      savePhoto(p);
      renderLists();
      syncMarkers();
      syncRoute();
    });
    $('selThumb').addEventListener('click', () => state.selectedId && openLightbox(state.selectedId));
    $('selCenter').addEventListener('click', () => {
      const p = state.photos.find((x) => x.id === state.selectedId);
      if (p && p.lat != null) state.map.easeTo({ center: [p.lng, p.lat], zoom: Math.max(state.map.getZoom(), 13) });
    });
    $('selPlace').addEventListener('click', () => state.selectedId && setPlacing(state.selectedId));
    $('selDelete').addEventListener('click', () => state.selectedId && removePhoto(state.selectedId));
    $('cancelPlace').addEventListener('click', () => setPlacing(null));

    // mapa
    $('btnFit').addEventListener('click', fitAll);
    $('btnResetNorth').addEventListener('click', () => state.map.easeTo({ bearing: 0 }));

    // búsqueda de lugares
    let geoTimer = null;
    $('geoInput').addEventListener('input', (e) => {
      clearTimeout(geoTimer);
      const q = e.target.value;
      geoTimer = setTimeout(async () => {
        const res = await Geocode.search(q);
        const box = $('geoResults');
        box.innerHTML = '';
        box.hidden = !res.length;
        res.forEach((r) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'geo-item';
          b.innerHTML = `<strong>${r.short}</strong><span>${r.label}</span>`;
          b.addEventListener('click', () => {
            box.hidden = true;
            $('geoInput').value = r.short;
            const p = state.photos.find((x) => x.id === state.selectedId);
            if (p && (state.placing === p.id || p.lat == null)) {
              p.lat = r.lat; p.lng = r.lng; p.fromExif = false;
              if (p.order == null) p.order = placed().length;
              savePhoto(p);
              setPlacing(null);
              renderLists();
              syncMarkers();
              syncRoute();
              state.map.easeTo({ center: [r.lng, r.lat], zoom: 14 });
              banner(`«${p.caption || p.name}» colocada en ${r.short}.`, 'ok');
            } else if (r.bbox) {
              state.map.fitBounds([[r.bbox[2], r.bbox[0]], [r.bbox[3], r.bbox[1]]], { padding: 60 });
            } else {
              state.map.easeTo({ center: [r.lng, r.lat], zoom: 13 });
            }
          });
          box.appendChild(b);
        });
      }, 350);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.geosearch')) $('geoResults').hidden = true;
    });

    // mapas
    $('mapSelect').addEventListener('change', (e) => openMap(e.target.value));
    $('btnNewMap').addEventListener('click', async () => {
      const name = prompt('Nombre del nuevo mapa:', 'Recorrido ' + (state.maps.length + 1));
      if (!name) return;
      const doc = { id: 'm_' + Date.now().toString(36), name, settings: defaultSettings(), createdAt: Date.now() };
      await DB.putMap(doc);
      const id = await loadMaps(doc.id);
      await openMap(id);
    });
    $('btnRenameMap').addEventListener('click', async () => {
      const name = prompt('Nuevo nombre:', state.mapDoc.name);
      if (!name) return;
      state.mapDoc.name = name;
      await DB.putMap(state.mapDoc);
      await loadMaps(state.mapDoc.id);
    });
    $('btnDuplicateMap').addEventListener('click', async () => {
      busy(true, 'Duplicando…');
      try {
        const id = 'm_' + Date.now().toString(36);
        await DB.putMap({
          id, name: state.mapDoc.name + ' (copia)',
          settings: structuredClone(state.mapDoc.settings),
          track: structuredClone(state.mapDoc.track || []),
          tripPhotos: structuredClone(state.mapDoc.tripPhotos || []),
          createdAt: Date.now()
        });
        for (const p of state.photos) {
          await DB.putPhoto(Object.assign(photoRecord(p), { id: Photos.uid(), mapId: id }));
        }
        const chosen = await loadMaps(id);
        await openMap(chosen);
      } finally { busy(false); }
    });
    $('btnDeleteMap').addEventListener('click', async () => {
      if (state.maps.length <= 1) { banner('Es el único mapa: no lo borro. Crea otro primero.', 'warn'); return; }
      if (!confirm(`¿Eliminar «${state.mapDoc.name}» y sus ${state.photos.length} fotos? No se puede deshacer.`)) return;
      await DB.deleteMap(state.mapDoc.id);
      const id = await loadMaps();
      await openMap(id);
    });

    // proyecto
    $('btnExportJson').addEventListener('click', exportProject);
    $('btnImport').addEventListener('click', () => $('importInput').click());
    $('importInput').addEventListener('change', (e) => {
      if (e.target.files[0]) importProject(e.target.files[0]);
      e.target.value = '';
    });

    // imagen
    $('btnExport').addEventListener('click', () => { updateExportSize(); $('exportDlg').showModal(); });
    $('exQuality').addEventListener('change', updateExportSize);
    $('exportDlg').addEventListener('close', () => {
      if ($('exportDlg').returnValue === 'ok') doExport();
    });

    // lightbox
    $('lbClose').addEventListener('click', () => { $('lightbox').hidden = true; });
    $('lbPrev').addEventListener('click', () => stepLightbox(-1));
    $('lbNext').addEventListener('click', () => stepLightbox(1));
    $('lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') $('lightbox').hidden = true; });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('lightbox').hidden) $('lightbox').hidden = true;
        else if (state.placing) setPlacing(null);
      }
      if (!$('lightbox').hidden) {
        if (e.key === 'ArrowLeft') stepLightbox(-1);
        if (e.key === 'ArrowRight') stepLightbox(1);
      }
    });

    let rz = null;
    window.addEventListener('resize', () => {
      clearTimeout(rz);
      rz = setTimeout(() => { if (state.map) { state.map.resize(); syncMarkers(); } }, 150);
    });
  }

  /* ---------------- arranque ---------------- */
  async function boot() {
    if (!window.maplibregl) {
      banner('No se cargó MapLibre. Sirve la carpeta por HTTP (no abras el archivo con doble clic) y revisa la conexión.', 'warn', true);
      return;
    }
    buildThemeGrid();
    /* Si wire() revienta a mitad, los controles que quedan por debajo se
       quedan sin listener y la app parece funcionar salvo que pulses justo
       uno de ellos. Un fallo así estuvo escondido hasta que lo cazó una
       prueba; mejor que se vea. */
    try {
      wire();
    } catch (e) {
      banner('Error al preparar los controles: ' + e.message + '. Parte de la interfaz no responderá.', 'warn', true);
      throw e;
    }
    const ok = await DB.ready();
    if (!ok) banner('El navegador no me deja usar almacenamiento local: trabajarás sin guardar. Exporta el proyecto antes de cerrar.', 'warn', true);
    try {
      state.library = await DB.getLibrary(LIB_ID);
    } catch (e) { state.library = null; }
    renderTrips();
    if (state.library) {
      $('scanSummary').hidden = false;
      $('scanSummary').innerHTML =
        `Último escaneo: <b>${fmtInt(state.library.records.length)}</b> fotos. ` +
        'Los archivos originales no sobreviven al cierre del navegador: para cargar imágenes nuevas hay que volver a escanear.';
    }
    const id = await loadMaps(localStorage.getItem('fr:lastMap'));
    await openMap(id);
    switchTab(state.photos.length ? 'map' : 'lib');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
