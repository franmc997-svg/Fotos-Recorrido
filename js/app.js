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
    lbIndex: -1
  };

  function defaultSettings() {
    return {
      title: 'MI RECORRIDO',
      subtitle: '',
      theme: 'neon',
      aspect: '9:16',
      pinStyle: 'teardrop',
      pinSize: 1,
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
      order: p.order, width: p.width, height: p.height,
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
      MapView.ensureRouteLayers(state.map, theme());
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
    im.src = thumbUrl(p);
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
    $('selThumb').src = thumbUrl(p);
    $('selCaption').value = p.caption || '';
    $('selLat').value = p.lat != null ? p.lat.toFixed(6) : '';
    $('selLng').value = p.lng != null ? p.lng.toFixed(6) : '';
    $('selDate').value = p.takenAt ? toLocalInput(p.takenAt) : '';
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
    const files = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|avif)$/i.test(f.name));
    if (!files.length) { banner('No reconocí ninguna imagen en lo que soltaste.', 'warn'); return; }

    const prog = $('ingestProgress');
    const bar = prog.querySelector('.bar');
    const label = prog.querySelector('span');
    prog.hidden = false;

    let withGps = 0, skipped = 0, heic = 0;
    for (let i = 0; i < files.length; i++) {
      label.textContent = `${i + 1} / ${files.length}`;
      bar.style.width = ((i / files.length) * 100).toFixed(1) + '%';
      await new Promise((r) => requestAnimationFrame(r));
      let rec;
      try {
        rec = await Photos.ingest(files[i], state.mapDoc.id);
      } catch (e) {
        skipped++;
        continue;
      }
      if (rec.error === 'HEIC') { heic++; continue; }
      if (rec.error) { skipped++; continue; }
      if (rec.lat != null) withGps++;
      rec.order = state.photos.length;
      state.photos.push(rec);
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

    const parts = [`${files.length - skipped - heic} fotos añadidas`, `${withGps} con GPS`];
    const noGps = files.length - skipped - heic - withGps;
    if (noGps > 0) parts.push(`${noGps} sin ubicación (colócalas a mano)`);
    if (heic) parts.push(`${heic} en HEIC que ningún navegador puede abrir: conviértelas a JPG`);
    if (skipped) parts.push(`${skipped} ilegibles`);
    banner(parts.join(' · '), heic || skipped ? 'warn' : 'ok');

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
          width: p.width, height: p.height,
          data: p.display ? await blobToDataUrl(p.display) : null
        });
      }
      const doc = {
        format: 'fotos-recorrido',
        version: 1,
        name: state.mapDoc.name,
        settings: state.mapDoc.settings,
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
        createdAt: Date.now()
      };
      await DB.putMap(mapDoc);
      for (const p of (doc.photos || [])) {
        if (!p.data) continue;
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
          takenAt: p.takenAt ?? null, order: p.order ?? null,
          width: bmp.width, height: bmp.height, display: blob, thumb
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
        await DB.putMap({ id, name: state.mapDoc.name + ' (copia)', settings: structuredClone(state.mapDoc.settings), createdAt: Date.now() });
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
    const id = await loadMaps(localStorage.getItem('fr:lastMap'));
    await openMap(id);
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
