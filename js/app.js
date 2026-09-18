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
      showTrack: true,
      showRoute: true,
      routeDashed: true,
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
    MapView.setTrack(state.map, state.mapDoc.track || [], {
      show: state.mapDoc.settings.showTrack && (state.mapDoc.track || []).length > 1,
      theme: theme()
    });
  }

  function syncRoute() {
    if (!state.map || !state.map.getSource('fr-route')) return;
    const coords = ordered().map((p) => [p.lng, p.lat]);
    MapView.setRoute(state.map, coords, {
      show: state.mapDoc.settings.showRoute,
      dashed: state.mapDoc.settings.routeDashed,
      theme: theme(),
      width: 2.4
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

    state.fileRefs = refs;
    const located = records.filter((r) => r.lat != null).length;
    const heic = records.filter((r) => r.kind === 'heic').length;
    const timedOut = records.filter((r) => r.timedOut).length;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);

    state.library = {
      id: LIB_ID,
      records: records.map((r) => ({
        idx: r.idx, name: r.name, kind: r.kind,
        lat: r.lat, lng: r.lng, takenAt: r.takenAt
      })),
      home: null,
      scannedAt: Date.now()
    };
    state.library.home = Trips.detectHome(state.library.records);
    await DB.putLibrary(state.library);

    $('scanSummary').hidden = false;
    $('scanSummary').innerHTML =
      `<b>${fmtInt(records.length)}</b> fotos leídas en ${secs}&nbsp;s · ` +
      `<b>${fmtInt(located)}</b> con ubicación · ${fmtInt(records.length - located)} sin ella` +
      (heic ? ` · ${fmtInt(heic)} en HEIC` : '') +
      (state.library.home
        ? `<br>Residencia detectada (${state.library.home.days} días distintos): sus fotos no cuentan como viaje.`
        : '<br>No detecté una residencia: trato todas las fotos como viaje.') +
      (timedOut
        ? `<br><b>${fmtInt(timedOut)}</b> foto(s) tardaron demasiado en leerse (posiblemente aún en iCloud, no descargadas al dispositivo) y quedaron sin ubicación.`
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

  async function createMapFromTrip(trip) {
    busy(true, 'Creando el mapa del viaje…');
    try {
      const id = 'm_' + Date.now().toString(36);
      const located = trip.photos.filter((p) => p.lat != null);
      const track = Trips.simplify(located.map((p) => [p.lng, p.lat]));
      const settings = defaultSettings();
      settings.title = Trips.label(trip);
      if (trip.centroid) {
        settings.center = trip.centroid;
        settings.zoom = 11;
      }
      const doc = {
        id, name: Trips.label(trip), settings, track,
        tripId: trip.id, createdAt: Date.now()
      };
      await DB.putMap(doc);

      const pins = Trips.suggestPins(trip.photos, SUGGESTED_PINS);
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

    const titleText = (s.title || '').toUpperCase();
    $('ovTitle').textContent = titleText;
    // el exportador encoge el título largo: la vista previa hace lo mismo
    $('ovTitle').style.fontSize = Exporter.titleSizeCqw(titleText) + 'cqw';
    $('ovTitle').hidden = !s.title;
    $('ovRule').hidden = !s.title;
    const subText = (s.subtitle || '').toUpperCase();
    $('ovSubtitle').textContent = subText;
    $('ovSubtitle').style.fontSize = Exporter.subtitleSizeCqw(subText, titleText) + 'cqw';
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
  }

  function fillSelection(p) {
    $('selPanel').hidden = false;
    $('selEmpty').hidden = true;
    $('selThumb').src = thumbOrPlaceholder(p);
    $('selCaption').value = p.caption || '';
    $('selLat').value = p.lat != null ? p.lat.toFixed(6) : '';
    $('selLng').value = p.lng != null ? p.lng.toFixed(6) : '';
    $('selDate').value = p.takenAt ? toLocalInput(p.takenAt) : '';
    $('selLoadImg').hidden = !!p.thumb || p.scanIdx == null || !state.fileRefs.has(p.scanIdx);
  }

  function toLocalInput(ms) {
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 16);
  }

  async function removePhoto(id) {
    const p = state.photos.find((x) => x.id === id);
    if (!p) return;
    if (!confirm(`¿Eliminar «${p.caption || p.name}» de este mapa?`)) return;
    await DB.deletePhoto(id);
    state.photos = state.photos.filter((x) => x.id !== id);
    if (state.thumbUrls.has(id)) { URL.revokeObjectURL(state.thumbUrls.get(id)); state.thumbUrls.delete(id); }
    if (state.displayUrls.has(id)) { URL.revokeObjectURL(state.displayUrls.get(id)); state.displayUrls.delete(id); }
    state.thumbImgs.delete(id);
    if (state.selectedId === id) clearSelection();
    renderLists();
    syncMarkers();
    syncRoute();
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
    $('orderMode').value = s.orderMode;
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
    wire();
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
