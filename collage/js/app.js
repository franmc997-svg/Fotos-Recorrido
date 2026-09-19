/* Taller de collage.

   Reutiliza el lector de EXIF, el descodificador HEIC y la detección de viajes
   de la herramienta de mapas (js/*.js), sin modificar nada de aquello. Lo que
   cambia es el destino: en vez de pines sobre un mapa vectorial, las fotos se
   convierten en las piezas que dibujan el mapa. */
(function () {
  const $ = (id) => document.getElementById(id);
  const PREVIEW_LONG = 1100;   // lado mayor del lienzo de vista previa
  const PATCH_PX = 760;        // resolución a la que se guarda cada pieza
  const STORE_PX = 640;        // resolución a la que se persiste en el navegador
  // Tope de piezas simultáneas. Coincide a propósito con el MAX_CACHE de
  // render.js: si se pintaran más piezas que caché de parches, el caché se
  // vaciaría entero dentro de un mismo repintado y cada pieza se recortaría
  // de nuevo en cada fotograma.
  const MAX_PIECES = 260;

  // Pasos de la distancia de agrupación: lineal no sirve, hace falta acertar
  // tanto 50 m como 20 km.
  const RADII = [50, 100, 150, 250, 350, 500, 750, 1000, 1500, 2500, 4000, 6000, 9000, 13000, 20000];

  const state = {
    records: [], refs: new Map(), trips: [], trip: null,
    stops: [], off: new Set(), imgs: new Map(),
    pieces: [], projectId: null, dirty: false
  };

  function defaults() {
    return {
      aspect: '2:3', ink: 'cianotipo',
      mapStrength: 0.8, mapStain: 0.45, mapLabels: false, frame: true,
      title: '', subtitle: '', showMeta: true, showFooter: true, titleScale: 1,
      shape: 'rasgado', size: 0.155, bleed: 0.35, separation: 0.32, weight: 0.55,
      pieceAlpha: 1, rotation: true, blend: 'normal', numbered: false,
      pieces: 16, groupRadiusM: 500,
      showTrack: true, trackWidth: 1, trackOpacity: 1,
      showRoute: true, routeDashed: false, routeAbove: true, routeLongOnly: true,
      routeWidth: 1.2, halo: 0.35,
      duotone: 0.7, contrast: 1.25, brightness: 0, grain: 0.09,
      texture: 0.7, grime: 0.45, shadow: 0.4, marks: true
    };
  }
  let s = defaults();

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
  function busy(on, txt) {
    $('busyText').textContent = txt || 'Trabajando…';
    $('busy').hidden = !on;
  }

  /* ---------------- 1. escaneo ---------------- */
  async function scan(files) {
    const list = [...files].filter((f) => Scan.kindOf(f) !== 'other');
    if (!list.length) { banner('Ninguno de esos archivos parece una foto.', 'warn'); return; }
    $('scanProgress').hidden = false;
    const bar = $('scanProgress').querySelector('.bar');
    const txt = $('scanProgress').querySelector('span');

    const job = Scan.run(list, {
      onProgress: (done, total) => {
        bar.style.width = (done / total * 100) + '%';
        txt.textContent = `${done} / ${total}`;
      }
    });
    const res = await job.promise;
    $('scanProgress').hidden = true;

    // Varias tandas se acumulan: en iOS el selector de fotos no deja coger
    // miles de golpe, así que hay que poder ir sumando.
    const byKey = new Map(state.records.map((r) => [r.idx, r]));
    for (const r of res.records) byKey.set(r.idx, r);
    state.records = [...byKey.values()];
    for (const [k, f] of res.refs) state.refs.set(k, f);

    const conGps = state.records.filter((r) => r.lat != null).length;
    $('scanSummary').hidden = false;
    $('scanSummary').textContent =
      `${state.records.length} fotos leídas · ${conGps} con coordenadas.`;
    if (!conGps) {
      banner('Ninguna foto trae coordenadas. Sin GPS no hay recorrido que dibujar.', 'warn', true);
      return;
    }
    detectTrips();
  }

  function detectTrips() {
    const trips = Trips.detect(state.records);
    state.trips = trips;
    $('tripSection').hidden = false;
    $('tripCount').textContent = String(trips.length);
    const ul = $('tripList');
    ul.innerHTML = '';

    if (!trips.length) {
      /* Sin viajes reconocibles no se deja al usuario en un callejón: se ofrece
         usar todas las fotos con GPS como un recorrido único, que es lo que
         suele querer quien acaba de soltar la carpeta de un fin de semana. */
      const rec = state.records.filter((r) => r.lat != null && r.takenAt != null);
      $('tripDiag').hidden = false;
      $('tripDiag').textContent = trips.rejected && trips.rejected.length
        ? 'No sale ningún viaje con los criterios por defecto. Puedes usar todas las fotos como un solo recorrido.'
        : 'Estas fotos no forman un viaje lejos de casa; se pueden usar igualmente.';
      if (rec.length >= 3) {
        const li = document.createElement('li');
        li.innerHTML = '<span class="grow"><span class="name">Todas las fotos con GPS</span>'
          + `<span class="tiny muted">${rec.length} fotos</span></span>`;
        const b = document.createElement('button');
        b.className = 'btn tiny primary';
        b.textContent = 'Usar';
        b.onclick = () => useTrip({
          photos: rec.slice().sort((a, b2) => a.takenAt - b2.takenAt),
          start: rec[0].takenAt, end: rec[rec.length - 1].takenAt, synthetic: true
        }, li);
        li.appendChild(b);
        ul.appendChild(li);
      }
      return;
    }
    $('tripDiag').hidden = true;

    for (const t of trips) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="grow"><span class="name">${Trips.label(t)}</span>`
        + `<span class="tiny muted">${t.photos.length} fotos · ${t.days} días</span></span>`;
      const b = document.createElement('button');
      b.className = 'btn tiny primary';
      b.textContent = 'Usar';
      b.onclick = () => useTrip(t, li);
      li.appendChild(b);
      ul.appendChild(li);
    }
  }

  async function useTrip(trip, li) {
    [...$('tripList').children].forEach((x) => x.classList.remove('is-active'));
    if (li) li.classList.add('is-active');
    state.trip = trip;
    state.off = new Set();
    state.imgs.clear();
    if (!s.title) {
      s.title = 'Cuaderno de viaje';
      $('inTitle').value = s.title;
    }
    /* El subtítulo se deja vacío a propósito: la línea de abajo ya lleva las
       fechas, y rellenarlo con lo mismo imprimía el rango dos veces. Queda
       para que el usuario escriba los lugares. */
    $('pieceSection').hidden = false;
    /* Por defecto entran todas las fotos con GPS: el collage es de fotos, no
       de una fotografía por parada. El tope solo aparece si el viaje trae más
       fotos de las que el papel puede permitirse (memoria de las imágenes
       descodificadas), y entonces se reparte por igual a lo largo del viaje. */
    const totalGps = trip.photos.filter((r) => r.lat != null && r.takenAt != null).length;
    s.pieces = Math.min(Math.max(totalGps, 3), MAX_PIECES);
    $('inPieces').value = s.pieces;
    $('inPiecesVal').textContent = String(s.pieces);
    await recomputeStops();
  }

  /* ---------------- 2. paradas y piezas ---------------- */
  async function recomputeStops() {
    if (!state.trip) return;
    const photos = state.trip.photos.filter((r) => r.lat != null && r.takenAt != null);
    state.stops = Trips.stops(photos, { radiusKm: s.groupRadiusM / 1000 });
    state.off = new Set();
    renderPieceList();
    await loadImages();
    rebuild();
  }

  /* Cada foto de cada parada activa es su propia pieza: antes solo se
     descodificaba la foto más centrada de cada parada, así que un collage de
     190 fotos en 37 paradas nunca enseñaba más de 37. El tope (s.pieces) ya
     no cuenta paradas, cuenta fotos, y si el viaje trae más de las que caben
     se reparten en el tiempo en vez de comerse solo el final. */
  function piecePhotos() {
    const list = [];
    for (const g of activeStops()) {
      const photos = g.photos && g.photos.length ? g.photos : (g.rep ? [g.rep] : []);
      for (const r of photos) list.push({ r, weight: g.count || photos.length || 1 });
    }
    const cap = Math.max(1, Math.min(s.pieces || MAX_PIECES, MAX_PIECES));
    if (list.length <= cap) return list;
    const picked = [];
    const seen = new Set();
    for (let i = 0; i < cap; i++) {
      const idx = Math.round(i * (list.length - 1) / Math.max(1, cap - 1));
      if (seen.has(idx)) continue;
      seen.add(idx);
      picked.push(list[idx]);
    }
    return picked;
  }

  const outliers = (list) => Layout.outliers(list, Trips.haversine);

  function renderOutlierHint() {
    const el = $('farHint');
    const btn = $('btnDropFar');
    if (!el) return;
    const far = outliers(activeStops());
    el.hidden = btn.hidden = !far.length;
    if (!far.length) return;
    const med = (arr) => { const s2 = arr.slice().sort((x, y) => x - y); return s2[Math.floor(s2.length / 2)]; };
    const cLat = med(activeStops().map((g) => g.lat));
    const cLng = med(activeStops().map((g) => g.lng));
    const lejos = Math.max(...far.map((g) => Trips.haversine(cLat, cLng, g.lat, g.lng)));
    el.textContent = far.length === 1
      ? `Un lugar está a ${Trips.fmtKm(lejos)} del resto y abre el mapa hasta ahí: `
        + 'por eso sale tanto papel vacío.'
      : `${far.length} lugares están hasta a ${Trips.fmtKm(lejos)} del resto y abren `
        + 'el mapa hasta ahí: por eso sale tanto papel vacío.';
    btn.textContent = far.length === 1 ? 'Dejar fuera ese lugar' : `Dejar fuera esos ${far.length}`;
  }

  function activeStops() {
    return state.stops.filter((g) => !state.off.has(g.id));
  }

  function renderPieceList() {
    $('pieceCount').textContent = String(piecePhotos().length);
    renderOutlierHint();
    const ul = $('pieceList');
    ul.innerHTML = '';
    state.stops.forEach((g, i) => {
      const li = document.createElement('li');
      if (state.off.has(g.id)) li.classList.add('is-off');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !state.off.has(g.id);
      cb.onchange = () => {
        if (cb.checked) state.off.delete(g.id); else state.off.add(g.id);
        renderPieceList();
        rebuild();
        markDirty();
      };
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1);
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = (g.rep && g.rep.name) || 'foto';
      const meta = document.createElement('span');
      meta.className = 'tiny muted';
      meta.textContent = g.count + '📷';
      li.append(cb, num, nm, meta);
      ul.appendChild(li);
    });
    const total = state.trip ? state.trip.photos.filter((r) => r.lat != null).length : 0;
    const shown = piecePhotos().length;
    $('pieceNote').textContent = state.stops.length
      ? (shown >= total
          ? `Se muestran las ${shown} fotos con GPS, repartidas en ${state.stops.length} lugares.`
          : `Se muestran ${shown} de ${total} fotos con GPS (sube "cuántas fotos entran" para ver más), `
            + `repartidas en ${state.stops.length} lugares.`)
      : '';
  }

  /* Descodificación. Se intenta primero la vía nativa del navegador, que en
     Safari de iPhone abre HEIC sin pasar por wasm y tarda una fracción. Solo si
     eso falla se llama al descodificador propio. */
  async function decodePatch(file) {
    let src = null;
    if (window.createImageBitmap) {
      try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch (e) { src = null; }
    }
    if (!src) src = await Photos.decode(file);
    const c = downscale(src, PATCH_PX);
    if (src.close) src.close();
    return c;
  }

  function downscale(src, max) {
    const sw = src.width, sh = src.height;
    const k = Math.min(1, max / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * k));
    c.height = Math.max(1, Math.round(sh * k));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  async function loadImages() {
    const seen = new Set();
    const pend = [];
    for (const { r } of piecePhotos()) {
      if (state.imgs.has(r.idx) || seen.has(r.idx)) continue;
      seen.add(r.idx);
      pend.push(r);
    }
    if (!pend.length) return;
    let done = 0, failed = 0;
    busy(true, `Abriendo imágenes… 0 / ${pend.length}`);
    for (const r of pend) {
      const file = state.refs.get(r.idx);
      try {
        if (!file) throw new Error('sin archivo');
        state.imgs.set(r.idx, await decodePatch(file));
      } catch (e) {
        failed++;
      }
      done++;
      busy(true, `Abriendo imágenes… ${done} / ${pend.length}`);
      // Un respiro entre fotos: sin esto la pestaña se congela y en el móvil
      // parece que la aplicación ha muerto.
      await new Promise((r2) => setTimeout(r2, 0));
    }
    busy(false);
    if (failed) {
      banner(`${failed} fotos no se pudieron abrir; salen como hueco en el collage.`, 'warn');
    }
  }

  /* ---------------- 3. composición ---------------- */
  function canvasSize(scale) {
    const base = window.ASPECTS[s.aspect] || window.ASPECTS['2:3'];
    return { w: Math.round(base.w * scale), h: Math.round(base.h * scale) };
  }
  function previewScale() {
    const base = window.ASPECTS[s.aspect] || window.ASPECTS['2:3'];
    return PREVIEW_LONG / Math.max(base.w, base.h);
  }

  function buildModel(W, H, base) {
    const list = piecePhotos();
    const trackPts = state.trip
      ? state.trip.photos.filter((r) => r.lat != null).sort((a, b) => (a.takenAt || 0) - (b.takenAt || 0))
      : [];

    /* El encuadre lo mandan las piezas elegidas, no todas las fotos del viaje.
       Antes mandaban todas, y eso hacía que desmarcar una foto lejana no
       sirviera de nada: seguía estirando el papel desde fuera. Con un viaje a
       Londres y una sola foto tomada en casa, el póster salía con el ochenta
       por ciento de océano y el collage aplastado en una esquina, sin forma de
       arreglarlo desde la interfaz. La traza sigue dibujándose entera; lo que
       se salga del encuadre se sale, que es lo que se espera al elegir. */
    const all = list.map(({ r }) => [r.lng, r.lat]);
    /* El margen se calcula a partir del tamaño de pieza: las piezas se
       dibujan centradas en su punto, así que la mitad de la pieza sobresale
       del encuadre de los puntos y hay que reservarle sitio, ni más ni menos.
       Con margen fijo o el collage se salía del papel o quedaba flotando en
       medio con un tercio del póster vacío. */
    const pad = s.size * 0.55;
    const proj = Project.fit(all, W, H, {
      padX: Math.min(0.26, 0.035 + pad),
      padTop: Math.min(0.24, 0.035 + pad),
      padBottom: Math.min(0.34, 0.20 + pad * 0.5)
    });

    const pieces = Layout.build(
      list.map(({ r, weight }) => {
        const img = state.imgs.get(r.idx);
        return {
          id: String(r.idx), lat: r.lat, lng: r.lng, takenAt: r.takenAt,
          weight, aspect: img ? img.width / img.height : 1
        };
      }),
      proj.project, W, H,
      {
        baseSize: s.size,
        sizeByWeight: s.weight,
        separation: 1 - s.separation,
        rotation: s.rotation ? 5 : 0,
        drift: 1.6
      }
    );
    pieces.forEach((p, i) => {
      p.img = state.imgs.get(list[i].r.idx) || null;
    });

    const track = Trips.simplify(trackPts.map((r) => proj.project(r.lng, r.lat)), 0.9);
    const route = pieces.map((p) => [p.x, p.y]);

    return {
      pieces, track, route, proj, base,
      title: s.title, subtitle: s.subtitle,
      meta: s.showMeta ? metaLine() : '',
      /* Con el mapa puesto hay que acreditar también a quien pone los datos:
         no es cortesía, es la licencia. */
      footer: s.showFooter
        ? ('fotos-recorrido · ' + (base ? MapView.ATTRIB : '© OpenStreetMap contributors'))
        : '',
      strain: Layout.strain(pieces, proj.pxPerKm(list.length ? list[0].r.lat : 0))
    };
  }

  /* Tamaño del viaje en kilómetros, para juzgar si el desplazamiento de las
     piezas es anecdótico o ha deformado el mapa. */
  function tripSpanKm() {
    const ph = state.trip ? state.trip.photos.filter((r) => r.lat != null) : [];
    if (ph.length < 2) return 0;
    let la1 = 90, la2 = -90, ln1 = 180, ln2 = -180;
    for (const r of ph) {
      if (r.lat < la1) la1 = r.lat;
      if (r.lat > la2) la2 = r.lat;
      if (r.lng < ln1) ln1 = r.lng;
      if (r.lng > ln2) ln2 = r.lng;
    }
    return Trips.haversine(la1, ln1, la2, ln2);
  }

  function metaLine() {
    if (!state.trip) return '';
    /* La distancia describe lo que enseña el póster, no el viaje entero.
       Si alguien deja fuera la foto de vuelta a casa, el collage pasa a ser
       solo Londres; poner ahí los 1420 km que incluyen el vuelo sería una
       mentira pequeña pero impresa. Se cuentan las fotos que caen dentro de
       la zona encuadrada, con holgura para no recortar por un metro. */
    const stops = activeStops();
    let photos = state.trip.photos.filter((r) => r.lat != null && r.takenAt != null);
    if (stops.length) {
      const la = stops.map((g) => g.lat), ln = stops.map((g) => g.lng);
      const padLa = Math.max(0.02, (Math.max(...la) - Math.min(...la)) * 0.25);
      const padLn = Math.max(0.02, (Math.max(...ln) - Math.min(...ln)) * 0.25);
      const dentro = photos.filter((r) =>
        r.lat >= Math.min(...la) - padLa && r.lat <= Math.max(...la) + padLa &&
        r.lng >= Math.min(...ln) - padLn && r.lng <= Math.max(...ln) + padLn);
      if (dentro.length > 1) photos = dentro;
    }
    const st = photos.length > 1 ? Trips.travelStats(photos) : null;
    const partes = [Trips.label(state.trip)];
    if (st && st.totalKm > 0) partes.push(Trips.fmtKm(st.totalKm));
    partes.push(activeStops().length + ' lugares');
    return partes.join('   ·   ');
  }

  /* Caché del mapa de fondo.

     Traer el mapa cuesta un par de segundos, y la mayoría de los controles
     (grano, contraste, forma de la pieza) no lo cambian. Se guarda con una
     clave que solo incluye lo que de verdad lo afecta —tamaño, cámara, tinta y
     rótulos— y mientras llega el nuevo se sigue dibujando el anterior, para
     que arrastrar un deslizador no se quede congelado. */
  const baseCache = { key: '', canvas: null, pending: '' };

  function baseKey(W, H, cam) {
    return [W, H, cam.center[0].toFixed(5), cam.center[1].toFixed(5),
      cam.zoom.toFixed(4), s.ink, s.mapLabels ? 1 : 0].join('|');
  }

  function requestBasemap(W, H, proj) {
    if (!s.mapStrength || !Basemap.available) return;
    const cam = proj.camera(W, H);
    const key = baseKey(W, H, cam);
    if (baseCache.key === key || baseCache.pending === key) return;
    baseCache.pending = key;
    $('mapHint').textContent = 'Trayendo el mapa…';
    Basemap.capture({ W, H, fit: proj, ink: inkOf(), labels: s.mapLabels })
      .then((cv) => {
        if (baseCache.pending !== key) return;   // llegó tarde: ya hay otra petición
        baseCache.key = key;
        baseCache.canvas = cv;
        baseCache.pending = '';
        $('mapHint').textContent = cv ? ''
          : 'No pude traer el mapa: sin conexión o bloqueado. El collage se dibuja igual.';
        draw();
      })
      .catch(() => { baseCache.pending = ''; $('mapHint').textContent = 'No pude traer el mapa.'; });
  }

  function inkOf() { return window.INKS[s.ink] || window.INKS.cianotipo; }

  let raf = 0;
  function rebuild() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  function draw() {
    const k = previewScale();
    const { w, h } = canvasSize(k);
    const cv = $('stage');
    cv.width = w; cv.height = h;
    cv.style.aspectRatio = `${w} / ${h}`;
    const has = state.trip && activeStops().length;
    $('stageEmpty').hidden = !!has;
    $('btnExport').disabled = !has;
    $('btnSave').disabled = !has;
    if (!has) {
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      return;
    }
    const model = buildModel(w, h, s.mapStrength ? baseCache.canvas : null);
    state.pieces = model.pieces;
    requestBasemap(w, h, model.proj);
    Render.render(cv.getContext('2d'), w, h, model, s);

    /* La distorsión se enseña siempre, no solo cuando se pasa de la raya: es
       la diferencia entre un mapa y un mural bonito, y el usuario tiene
       derecho a saber cuál de los dos está mirando. */
    const hint = $('strainHint');
    const st = model.strain;
    hint.hidden = false;
    if (st.ratio < 0.4) {
      hint.textContent = 'Las fotos están prácticamente en su sitio.';
    } else if (st.ratio < 1.6) {
      hint.textContent = `Las piezas se han corrido como mucho su propio tamaño `
        + `(${Trips.fmtKm(st.medianKm)} de media). El mapa se sigue leyendo.`;
    } else {
      hint.textContent = `Las piezas se han corrido ${st.ratio.toFixed(1)} veces su tamaño `
        + `(${Trips.fmtKm(st.medianKm)} de media): el mapa se está deformando. `
        + 'Con menos piezas o más pequeñas vuelve a su sitio.';
    }
    hint.className = st.ratio >= 1.6 ? 'tiny warn-text' : 'tiny muted';
  }

  /* ---------------- exportación ---------------- */
  async function exportImage() {
    const scale = Number($('exQuality').value) || 2;
    const fmt = $('exFormat').value === 'jpeg' ? 'jpeg' : 'png';
    const { w, h } = canvasSize(scale);
    busy(true, `Generando ${w} × ${h}…`);
    try {
      // Un respiro para que el indicador se pinte antes de bloquear el hilo.
      await new Promise((r) => setTimeout(r, 30));
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      /* El mapa de la vista previa no sirve aquí: ampliado a tres veces se
         vería borroso justo debajo de unas fotos nítidas. Se pide otro a la
         resolución final. */
      let base = null;
      if (s.mapStrength && Basemap.available) {
        busy(true, 'Trayendo el mapa a resolución final…');
        base = await Basemap.capture({ W: w, H: h, fit: buildModel(w, h, null).proj,
          ink: inkOf(), labels: s.mapLabels });
        busy(true, `Generando ${w} × ${h}…`);
      }
      Render.render(cv.getContext('2d'), w, h, buildModel(w, h, base), s);
      const blob = await new Promise((res) =>
        cv.toBlob(res, fmt === 'jpeg' ? 'image/jpeg' : 'image/png', 0.92));
      if (!blob) throw new Error('blob');
      const name = (s.title || 'collage').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'collage';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name}-${w}x${h}.${fmt === 'jpeg' ? 'jpg' : 'png'}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      banner(`Imagen lista: ${w} × ${h} px`, 'ok');
    } catch (e) {
      banner('No pude generar la imagen. Prueba con una resolución menor.', 'error', true);
    } finally {
      // La caché guarda piezas a resolución de exportación: si se queda, la
      // vista previa siguiente arrastra cientos de megas de más.
      Render.clearCache();
      busy(false);
      draw();
    }
  }

  /* ---------------- proyectos ---------------- */
  function markDirty() { state.dirty = true; $('saveNote').textContent = 'Hay cambios sin guardar.'; }

  async function saveProject() {
    if (!state.trip) return;
    busy(true, 'Guardando…');
    try {
      const pieces = [];
      for (const { r, weight } of piecePhotos()) {
        const img = state.imgs.get(r.idx);
        let blob = null;
        if (img) {
          const small = downscale(img, STORE_PX);
          blob = await new Promise((res) => small.toBlob(res, 'image/jpeg', 0.82));
        }
        pieces.push({
          id: String(r.idx), lat: r.lat, lng: r.lng, start: r.takenAt, count: weight,
          name: r.name || '', idx: r.idx, blob
        });
      }
      const doc = {
        id: state.projectId || ('c_' + Date.now().toString(36)),
        name: s.title || 'Collage',
        settings: s,
        pieces,
        track: state.trip.photos.filter((r) => r.lat != null)
          .map((r) => [r.lng, r.lat, r.takenAt || 0]),
        label: Trips.label(state.trip),
        createdAt: Date.now()
      };
      await Store.put(doc);
      state.projectId = doc.id;
      state.dirty = false;
      $('saveNote').textContent = 'Guardado en este navegador.';
      banner('Proyecto guardado.', 'ok');
    } catch (e) {
      banner('No pude guardar el proyecto.', 'error');
    } finally { busy(false); }
  }

  async function openProject(doc) {
    busy(true, 'Abriendo proyecto…');
    try {
      s = Object.assign(defaults(), doc.settings || {});
      state.projectId = doc.id;
      state.imgs.clear();
      state.off = new Set();
      const photos = (doc.track || []).map((t, i) => ({
        idx: 'r' + i, lng: t[0], lat: t[1], takenAt: t[2] || null, name: ''
      }));
      state.trip = {
        photos, start: photos.length ? photos[0].takenAt : 0,
        end: photos.length ? photos[photos.length - 1].takenAt : 0,
        restored: doc.label || ''
      };
      // El tope de piezas es de fotos, no de paradas; si el proyecto guardado
      // trae más piezas que el tope restaurado (settings antiguos, o menos
      // de las que de verdad se guardaron), no hay que recortarlo al abrirlo.
      s.pieces = Math.min(MAX_PIECES, Math.max(s.pieces || 0, (doc.pieces || []).length));
      state.stops = (doc.pieces || []).map((p) => {
        const rep = { idx: p.idx || p.id, lat: p.lat, lng: p.lng, takenAt: p.start, name: p.name };
        return {
          id: p.id, lat: p.lat, lng: p.lng, start: p.start, end: p.start,
          count: p.count || 1, minutes: 0,
          rep, photos: [rep]
        };
      });
      for (const p of doc.pieces || []) {
        if (!p.blob) continue;
        try {
          const bmp = await createImageBitmap(p.blob);
          state.imgs.set(p.idx || p.id, downscale(bmp, PATCH_PX));
          if (bmp.close) bmp.close();
        } catch (e) { /* pieza sin imagen: sale como hueco */ }
      }
      $('pieceSection').hidden = false;
      $('tripSection').hidden = true;
      syncControls();
      renderPieceList();
      draw();
      /* Las piezas guardadas están a 640 px: bastan para pantalla y para 2×,
         pero conviene decirlo antes de que alguien imprima a 3× y lo note. */
      banner('Proyecto abierto. Las imágenes guardadas son de menor resolución; '
        + 'vuelve a elegir los archivos si quieres imprimir a 3×.', 'info', true);
    } catch (e) {
      banner('Ese proyecto no se pudo abrir.', 'error');
    } finally { busy(false); }
  }

  async function showProjects() {
    const list = await Store.all();
    const ul = $('loadList');
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<li class="tiny muted">Todavía no hay proyectos guardados.</li>';
    }
    for (const doc of list) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="grow"><span class="name">${doc.name || 'Collage'}</span>`
        + `<span class="tiny muted">${doc.label || ''} · ${(doc.pieces || []).length} piezas</span></span>`;
      const open = document.createElement('button');
      open.className = 'btn tiny primary';
      open.textContent = 'Abrir';
      open.onclick = () => { $('loadDlg').close(); openProject(doc); };
      const del = document.createElement('button');
      del.className = 'btn tiny ghost danger';
      del.textContent = 'Borrar';
      del.onclick = async (e) => {
        e.preventDefault();
        await Store.remove(doc.id);
        showProjects();
      };
      li.append(open, del);
      ul.appendChild(li);
    }
    $('loadDlg').showModal();
  }

  /* ---------------- controles ---------------- */
  function syncControls() {
    $('inTitle').value = s.title;
    $('inSubtitle').value = s.subtitle;
    $('inMeta').checked = s.showMeta;
    $('inFooter').checked = s.showFooter;
    $('inAspect').value = s.aspect;
    $('inInk').value = s.ink;
    $('inShape').value = s.shape;
    $('inRotation').checked = s.rotation;
    $('inMultiply').checked = s.blend === 'multiply';
    $('inNumbered').checked = s.numbered;
    $('inTrack').checked = s.showTrack;
    $('inRoute').checked = s.showRoute;
    $('inRouteDashed').checked = s.routeDashed;
    $('inRouteAbove').checked = !!s.routeAbove;
    $('inRouteLong').checked = !!s.routeLongOnly;
    $('inMarks').checked = s.marks;
    $('inFrame').checked = s.frame;
    $('inMapLabels').checked = s.mapLabels;
    const put = (id, v, dec) => {
      $(id).value = v;
      const lab = $(id + 'Val');
      if (lab) lab.textContent = dec == null ? v : Number(v).toFixed(dec);
    };
    put('inTitleScale', Math.round(s.titleScale * 100));
    put('inPieces', s.pieces);
    put('inSize', Math.round(s.size * 100));
    put('inBleed', Math.round(s.bleed * 100));
    put('inSeparation', Math.round(s.separation * 100));
    put('inWeight', Math.round(s.weight * 100));
    put('inAlpha', Math.round(s.pieceAlpha * 100));
    put('inRouteWidth', s.routeWidth, 1);
    put('inHalo', Math.round(s.halo * 100));
    put('inDuotone', Math.round(s.duotone * 100));
    put('inContrast', s.contrast, 2);
    put('inBrightness', s.brightness, 2);
    put('inGrain', Math.round(s.grain * 100));
    put('inTexture', Math.round(s.texture * 100));
    put('inGrime', Math.round(s.grime * 100));
    put('inShadow', Math.round(s.shadow * 100));
    put('inMap', Math.round(s.mapStrength * 100));
    put('inMapStain', Math.round(s.mapStain * 100));
    $('inGroup').value = String(RADII.indexOf(s.groupRadiusM) >= 0 ? RADII.indexOf(s.groupRadiusM) : 4);
    $('inGroupVal').textContent = fmtM(s.groupRadiusM);
  }

  function fmtM(m) { return m >= 1000 ? (m / 1000) + ' km' : m + ' m'; }

  function wire() {
    const asp = $('inAspect');
    for (const k of Object.keys(window.ASPECTS)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = window.ASPECTS[k].label;
      asp.appendChild(o);
    }
    const ink = $('inInk');
    for (const k of Object.keys(window.INKS)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = window.INKS[k].label;
      ink.appendChild(o);
    }

    $('btnPick').onclick = () => $('fileInput').click();
    $('btnPickFolder').onclick = () => $('folderInput').click();
    $('fileInput').onchange = (e) => { scan(e.target.files); e.target.value = ''; };
    $('folderInput').onchange = (e) => { scan(e.target.files); e.target.value = ''; };

    // Deslizadores y casillas: cambio -> ajuste -> repintado.
    const range = (id, apply, fmt) => {
      const el = $(id), lab = $(id + 'Val');
      el.addEventListener('input', () => {
        const v = Number(el.value);
        if (lab) lab.textContent = fmt ? fmt(v) : String(v);
        apply(v);
        rebuild();
        markDirty();
      });
    };
    const check = (id, apply) => $(id).addEventListener('change', (e) => {
      apply(e.target.checked); rebuild(); markDirty();
    });
    const text = (id, apply) => $(id).addEventListener('input', (e) => {
      apply(e.target.value); rebuild(); markDirty();
    });

    text('inTitle', (v) => { s.title = v; });
    text('inSubtitle', (v) => { s.subtitle = v; });
    check('inMeta', (v) => { s.showMeta = v; });
    check('inFooter', (v) => { s.showFooter = v; });
    range('inTitleScale', (v) => { s.titleScale = v / 100; });

    $('inAspect').onchange = (e) => { s.aspect = e.target.value; Render.clearCache(); rebuild(); markDirty(); };
    $('inInk').onchange = (e) => { s.ink = e.target.value; rebuild(); markDirty(); };
    $('inShape').onchange = (e) => { s.shape = e.target.value; Render.clearCache(); rebuild(); markDirty(); };

    range('inSize', (v) => { s.size = v / 100; Render.clearCache(); }, (v) => v + '%');
    range('inBleed', (v) => { s.bleed = v / 100; Render.clearCache(); }, (v) => v + '%');
    range('inSeparation', (v) => { s.separation = v / 100; }, (v) => v + '%');
    range('inWeight', (v) => { s.weight = v / 100; Render.clearCache(); }, (v) => v + '%');
    range('inAlpha', (v) => { s.pieceAlpha = v / 100; }, (v) => v + '%');
    check('inRotation', (v) => { s.rotation = v; });
    check('inMultiply', (v) => { s.blend = v ? 'multiply' : 'normal'; });
    check('inNumbered', (v) => { s.numbered = v; });

    check('inTrack', (v) => { s.showTrack = v; });
    check('inRoute', (v) => { s.showRoute = v; });
    check('inRouteDashed', (v) => { s.routeDashed = v; });
    check('inRouteAbove', (v) => { s.routeAbove = v; });
    check('inRouteLong', (v) => { s.routeLongOnly = v; });
    range('inRouteWidth', (v) => { s.routeWidth = v; }, (v) => v.toFixed(1));
    range('inHalo', (v) => { s.halo = v / 100; }, (v) => v + '%');

    range('inDuotone', (v) => { s.duotone = v / 100; }, (v) => v + '%');
    range('inContrast', (v) => { s.contrast = v; }, (v) => v.toFixed(2));
    range('inBrightness', (v) => { s.brightness = v; }, (v) => v.toFixed(2));
    range('inGrain', (v) => { s.grain = v / 100; }, (v) => v + '%');
    range('inTexture', (v) => { s.texture = v / 100; }, (v) => v + '%');
    range('inGrime', (v) => { s.grime = v / 100; }, (v) => v + '%');
    range('inShadow', (v) => { s.shadow = v / 100; }, (v) => v + '%');
    check('inMarks', (v) => { s.marks = v; });
    check('inFrame', (v) => { s.frame = v; });
    range('inMap', (v) => { s.mapStrength = v / 100; }, (v) => v + '%');
    range('inMapStain', (v) => { s.mapStain = v / 100; }, (v) => v + '%');
    check('inMapLabels', (v) => { s.mapLabels = v; });

    // Estos dos sí rehacen las paradas, que es caro: van al soltar, no al mover.
    $('inPieces').addEventListener('input', (e) => {
      s.pieces = Number(e.target.value);
      $('inPiecesVal').textContent = e.target.value;
    });
    $('inPieces').addEventListener('change', () => { recomputeStops(); markDirty(); });
    $('inGroup').addEventListener('input', (e) => {
      s.groupRadiusM = RADII[Number(e.target.value)] || 350;
      $('inGroupVal').textContent = fmtM(s.groupRadiusM);
    });
    $('inGroup').addEventListener('change', () => { recomputeStops(); markDirty(); });

    $('btnExport').onclick = () => {
      const { w, h } = canvasSize(Number($('exQuality').value) || 2);
      $('exSize').textContent = `${w} × ${h} px`;
      $('exportDlg').showModal();
    };
    $('exQuality').onchange = () => {
      const { w, h } = canvasSize(Number($('exQuality').value) || 2);
      $('exSize').textContent = `${w} × ${h} px`;
    };
    $('exportDlg').addEventListener('close', () => {
      if ($('exportDlg').returnValue === 'ok') exportImage();
    });

    $('btnDropFar').onclick = () => {
      for (const g of outliers(activeStops())) state.off.add(g.id);
      renderPieceList();
      rebuild();
      markDirty();
    };
    $('btnSave').onclick = saveProject;
    $('btnLoad').onclick = showProjects;
    $('btnReset').onclick = () => {
      s = Object.assign(defaults(), { title: s.title, subtitle: s.subtitle });
      Render.clearCache();
      syncControls();
      rebuild();
    };

    window.addEventListener('resize', () => rebuild());
  }

  function boot() {
    try {
      wire();
      syncControls();
      draw();
    } catch (e) {
      banner('Algo falló al arrancar la herramienta: ' + e.message, 'error', true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
  window.__collage = { state, get settings() { return s; }, draw, buildModel, canvasSize };
})();
