/* Exportación a imagen.

   Truco necesario: MapLibre dimensiona su canvas como cssPx × devicePixelRatio.
   Para sacar un póster de 2160×3840 creamos un mapa oculto de 1080×1920 css y
   forzamos devicePixelRatio = 2 durante su construcción. Además subimos el zoom
   en log2(anchoExport / anchoEditor) para que el encuadre sea el mismo que ves
   en pantalla: si no, el mapa grande mostraría mucha más superficie. */
(function () {
  const FONT = '"Helvetica Neue", Helvetica, Arial, system-ui, sans-serif';
  const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const RATIO = 2;

  function hexToRgba(hex, a) {
    const h = hex.replace('#', '');
    const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(s, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function fmtCoords(lat, lng) {
    const la = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}`;
    const lo = `${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'W'}`;
    return `${la} / ${lo}`;
  }

  /* Canvas soporta letterSpacing sólo en navegadores recientes; dibujamos
     carácter a carácter para que el tracking del título salga siempre. */
  function measureTracked(ctx, text, spacing) {
    let w = 0;
    for (const ch of text) w += ctx.measureText(ch).width + spacing;
    return w - (text.length ? spacing : 0);
  }
  function drawTracked(ctx, text, cx, y, spacing) {
    const total = measureTracked(ctx, text, spacing);
    let x = cx - total / 2;
    const prev = ctx.textAlign;
    ctx.textAlign = 'left';
    for (const ch of text) {
      ctx.fillText(ch, x, y);
      x += ctx.measureText(ch).width + spacing;
    }
    ctx.textAlign = prev;
  }

  function waitIdle(map, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const tick = () => {
        if (done) return;
        if (map.loaded() && map.areTilesLoaded()) return finish();
        setTimeout(tick, 120);
      };
      map.once('idle', tick);
      setTimeout(tick, 400);
      setTimeout(finish, timeoutMs || 25000); // no nos colgamos si un tile falla
    });
  }

  function drawPinCanvas(ctx, x, y, w, theme, style, index, img) {
    const P = MapView.PIN;
    // igual que en el editor: sin imagen cargada, el pin de foto es una gota
    if (style === 'photo' && !img) style = 'teardrop';
    if (style === 'photo') {
      const d = w * 1.55;
      const cy = y - w * 0.34 - d / 2;
      const ring = Math.max(1.5, w * 0.09);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x - w * 0.25, y - w * 0.34);
      ctx.lineTo(x + w * 0.25, y - w * 0.34);
      ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fillStyle = theme.accent;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, cy, d / 2, 0, Math.PI * 2);
      ctx.fillStyle = theme.accentInk;
      ctx.fill();
      if (img) {
        ctx.save();
        ctx.clip();
        const s = Math.max(d / img.width, d / img.height);
        const iw = img.width * s, ih = img.height * s;
        ctx.drawImage(img, x - iw / 2, cy - ih / 2, iw, ih);
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(x, cy, d / 2 - ring / 2, 0, Math.PI * 2);
      ctx.lineWidth = ring;
      ctx.strokeStyle = theme.accent;
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (style === 'dot') {
      const r = w * 0.26;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(theme.accent, 0.22);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = theme.accent;
      ctx.fill();
      ctx.restore();
      return;
    }
    // gota clásica / numerada
    const s = w / P.vbW;
    ctx.save();
    ctx.translate(x - w / 2, y - P.vbH * s);
    ctx.scale(s, s);
    ctx.fillStyle = theme.accent;
    ctx.fill(new Path2D(P.path));
    if (style === 'numbered') {
      ctx.fillStyle = theme.accentInk;
      ctx.font = `700 ${13}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(index + 1), P.holeCx, P.holeCy + 0.5);
    } else {
      ctx.beginPath();
      ctx.arc(P.holeCx, P.holeCy, P.holeR, 0, Math.PI * 2);
      ctx.fillStyle = theme.accentInk;
      ctx.fill();
    }
    ctx.restore();
  }

  /* Layout del texto, en unidades de 1% del ancho (equivale a 1cqw en CSS).
     El editor usa exactamente estas mismas constantes, así que la vista previa
     y la imagen descargada coinciden. Ver css/style.css y LAYOUT en app.js. */
  const L = {
    titleBase: 18.4, titleTrack: 0.22, titleMax: 6.9, titleBudget: 84,
    ruleY: 14.6, ruleW: 17.6,
    subBase: 11.4, subSize: 2.5, subTrack: 0.14, subBudget: 76, subOfTitle: 0.42,
    coordsBase: 7.4, coordsSize: 1.6,
    footBase: 2.4, footSize: 1.3, footPad: 2.4,
    legendBase: 27.5, legendSize: 1.7, legendLine: 2.6, legendX: 5.2, legendGap: 3.6
  };

  /* Ancho real del texto con interletrado, medido a un tamaño de referencia y
     expresado por unidad de tamaño de fuente. Estimarlo con un ancho medio de
     carácter desbordaba los títulos largos. */
  let scratch = null;
  function trackedWidthPerUnit(text, weight, track, family) {
    if (!scratch) scratch = document.createElement('canvas').getContext('2d');
    const ref = 100;
    scratch.font = `${weight} ${ref}px ${family}`;
    let w = 0;
    for (const ch of text) w += scratch.measureText(ch).width + ref * track;
    if (text.length) w -= ref * track;
    return w / ref;
  }

  function titleSizeCqw(text) {
    const t = (text || '').toUpperCase();
    if (!t) return L.titleMax;
    const per = trackedWidthPerUnit(t, 300, L.titleTrack, FONT);
    return per > 0 ? Math.min(L.titleMax, L.titleBudget / per) : L.titleMax;
  }

  /* El subtítulo nunca puede acercarse al tamaño del título: si un título
     largo se encoge, el subtítulo se encoge con él o se pierde la jerarquía. */
  function subtitleSizeCqw(text, title) {
    const t = (text || '').toUpperCase();
    if (!t) return L.subSize;
    const per = trackedWidthPerUnit(t, 400, L.subTrack, FONT);
    const byWidth = per > 0 ? L.subBudget / per : L.subSize;
    const byTitle = title ? titleSizeCqw(title) * L.subOfTitle : L.subSize;
    return Math.min(L.subSize, byWidth, byTitle);
  }

  function drawOverlay(ctx, W, H, o) {
    const theme = o.theme;
    const u = W / 100; // 1cqw

    // Degradado inferior para que el texto se lea sobre el mapa.
    const g = ctx.createLinearGradient(0, H * 0.52, 0, H);
    g.addColorStop(0, hexToRgba(theme.bg, 0));
    g.addColorStop(0.55, hexToRgba(theme.bg, 0.55));
    g.addColorStop(1, hexToRgba(theme.bg, 0.92));
    ctx.fillStyle = g;
    ctx.fillRect(0, H * 0.52, W, H * 0.48);

    ctx.textBaseline = 'alphabetic';

    if (o.legend && o.legendItems.length) {
      ctx.textAlign = 'left';
      ctx.font = `400 ${L.legendSize * u}px ${MONO}`;
      let ly = H - L.legendBase * u - (o.legendItems.length - 1) * L.legendLine * u;
      for (let i = 0; i < o.legendItems.length; i++) {
        ctx.fillStyle = theme.accent;
        ctx.fillText(String(i + 1).padStart(2, '0'), L.legendX * u, ly);
        ctx.fillStyle = theme.sub;
        ctx.fillText(o.legendItems[i], (L.legendX + L.legendGap) * u, ly);
        ly += L.legendLine * u;
      }
    }

    ctx.textAlign = 'center';

    if (o.title) {
      const text = o.title.toUpperCase();
      const size = titleSizeCqw(text) * u;
      ctx.font = `300 ${size}px ${FONT}`;
      ctx.fillStyle = theme.title;
      drawTracked(ctx, text, W / 2, H - L.titleBase * u, size * L.titleTrack);

      ctx.strokeStyle = hexToRgba(theme.title, 0.55);
      ctx.lineWidth = Math.max(1, 0.13 * u);
      ctx.beginPath();
      ctx.moveTo(W / 2 - (L.ruleW / 2) * u, H - L.ruleY * u);
      ctx.lineTo(W / 2 + (L.ruleW / 2) * u, H - L.ruleY * u);
      ctx.stroke();
    }

    if (o.subtitle) {
      const size = subtitleSizeCqw(o.subtitle, o.title) * u;
      ctx.font = `400 ${size}px ${FONT}`;
      ctx.fillStyle = theme.sub;
      drawTracked(ctx, o.subtitle.toUpperCase(), W / 2, H - L.subBase * u, size * L.subTrack);
    }

    if (o.coords) {
      ctx.font = `400 ${L.coordsSize * u}px ${MONO}`;
      ctx.fillStyle = theme.dim;
      ctx.fillText(o.coords, W / 2, H - L.coordsBase * u);
    }

    // La atribución de OSM/CARTO es obligatoria por licencia: se dibuja siempre.
    ctx.font = `400 ${L.footSize * u}px ${MONO}`;
    ctx.fillStyle = hexToRgba(theme.dim, 0.9);
    ctx.textAlign = 'right';
    ctx.fillText(MapView.ATTRIB, W - L.footPad * u, H - L.footBase * u);
    if (o.footer && o.brand) {
      ctx.textAlign = 'left';
      ctx.fillText(o.brand, L.footPad * u, H - L.footBase * u);
    }
  }

  /* opts: { aspect, quality, format, settings, photos, thumbs, editorWidth,
             camera:{center,zoom,bearing} } */
  async function render(opts) {
    const base = window.ASPECTS[opts.aspect] || window.ASPECTS['9:16'];
    const q = Number(opts.quality) || 2;
    const W = Math.round(base.w * q);
    const H = Math.round(base.h * q);
    const cssW = W / RATIO;
    const cssH = H / RATIO;
    const theme = window.THEMES[opts.settings.theme] || window.THEMES.neon;

    const host = document.createElement('div');
    host.style.cssText = `position:absolute;left:-20000px;top:0;width:${cssW}px;height:${cssH}px;`;
    document.body.appendChild(host);

    const realDpr = window.devicePixelRatio;
    let dprPatched = false;
    try {
      Object.defineProperty(window, 'devicePixelRatio', { get: () => RATIO, configurable: true });
      dprPatched = true;
    } catch (e) { /* si no se puede parchear, salimos al dpr real */ }

    const zoomDelta = Math.log2(cssW / Math.max(1, opts.editorWidth));
    let map;
    try {
      map = new maplibregl.Map({
        container: host,
        style: MapView.STYLE_URL,
        center: opts.camera.center,
        zoom: opts.camera.zoom + zoomDelta,
        bearing: opts.camera.bearing || 0,
        pitch: 0,
        interactive: false,
        attributionControl: false,
        preserveDrawingBuffer: true,
        fadeDuration: 0
      });

      await new Promise((res) => map.once('load', res));
      MapView.applyTheme(map, theme, !!opts.settings.showLabels);
      MapView.ensureTrackLayers(map, theme);
      MapView.setTrack(map, opts.trackCoords || [], {
        show: !!opts.settings.showTrack && (opts.trackCoords || []).length > 1,
        theme
      });
      MapView.ensureRouteLayers(map, theme);
      MapView.setRoute(map, opts.routeCoords, {
        show: !!opts.settings.showRoute,
        dashed: !!opts.settings.routeDashed,
        theme,
        width: 2.4 * (cssW / 540)
      });
      map.triggerRepaint();
      await waitIdle(map, 30000);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const out = document.createElement('canvas');
      out.width = W;
      out.height = H;
      const ctx = out.getContext('2d');
      ctx.fillStyle = theme.bg;
      ctx.fillRect(0, 0, W, H);

      const src = map.getCanvas();
      ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, W, H);

      // Pines, en el mismo orden que la ruta.
      const pinW = MapView.PIN.baseWidth * (W / 1080) * (opts.settings.pinSize || 1);
      const style = opts.settings.pinStyle || 'teardrop';
      opts.photos.forEach((p, i) => {
        const pt = map.project([p.lng, p.lat]);
        drawPinCanvas(ctx, pt.x * RATIO, pt.y * RATIO, pinW, theme, style, i, opts.thumbs[p.id]);
      });

      const c = map.getCenter();
      drawOverlay(ctx, W, H, {
        theme,
        title: opts.settings.title,
        subtitle: opts.settings.subtitle,
        coords: opts.settings.showCoords ? fmtCoords(c.lat, c.lng) : '',
        footer: !!opts.settings.showFooter,
        brand: 'fotos-recorrido',
        legend: !!opts.settings.showLegend,
        legendItems: opts.settings.showLegend
          ? opts.photos.slice(0, 12).map((p) => (p.caption || p.name || '').slice(0, 40))
          : []
      });

      const type = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const blob = await new Promise((res) => out.toBlob(res, type, 0.92));
      return { blob, width: W, height: H, type };
    } finally {
      if (map) map.remove();
      host.remove();
      if (dprPatched) {
        Object.defineProperty(window, 'devicePixelRatio', { get: () => realDpr, configurable: true });
      }
    }
  }

  window.Exporter = { render, fmtCoords, hexToRgba, LAYOUT: L, titleSizeCqw, subtitleSizeCqw };
})();
