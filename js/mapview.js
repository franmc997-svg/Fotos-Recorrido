/* Mapa y pines. MapLibre con estilo vectorial, porque hace falta:
   1) recolorear cada capa para conseguir el look de póster, y
   2) exportar el canvas a PNG (con html2canvas sobre tiles raster el canvas
      queda "tainted" por CORS y toDataURL lanza SecurityError). */
(function () {
  const DEFAULT_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

  /* Se puede sustituir el estilo base por otro (MapTiler con tu clave, un
     estilo propio, o uno local para trabajar sin red) con ?style=URL, que
     queda recordado, o borrándolo con ?style=reset. */
  function resolveStyle() {
    try {
      const q = new URLSearchParams(location.search).get('style');
      if (q === 'reset') { localStorage.removeItem('fr:style'); return DEFAULT_STYLE; }
      if (q) { localStorage.setItem('fr:style', q); return q; }
      return localStorage.getItem('fr:style') || DEFAULT_STYLE;
    } catch (e) {
      return DEFAULT_STYLE;
    }
  }

  const STYLE_URL = resolveStyle();
  const ATTRIB = STYLE_URL === DEFAULT_STYLE
    ? '© OpenStreetMap contributors © CARTO'
    : '© OpenStreetMap contributors';

  /* Geometría del pin compartida entre el editor (SVG) y la exportación
     (Path2D), para que lo que ves sea lo que descargas. */
  const PIN = {
    vbW: 24, vbH: 36,
    path: 'M12 0C5.373 0 0 5.373 0 12c0 8.5 12 24 12 24s12-15.5 12-24C24 5.373 18.627 0 12 0z',
    holeR: 4.6, holeCx: 12, holeCy: 12,
    baseWidth: 38 // px de ancho a 1080 px de lienzo, escala 1
  };

  function classify(layer) {
    const sl = String(layer['source-layer'] || '').toLowerCase();
    const id = String(layer.id || '').toLowerCase();
    if (layer.type === 'background') return 'bg';
    if (layer.type === 'symbol') return 'label';
    if (sl === 'water' || /water|ocean|sea|lake/.test(id)) return 'water';
    if (sl === 'waterway' || /waterway|river|stream|canal/.test(id)) return 'waterway';
    if (sl === 'building' || /building/.test(id)) return 'building';
    if (sl === 'transportation' || /road|street|motorway|bridge|tunnel|rail|transit|highway|aeroway/.test(id)) {
      if (/casing|outline/.test(id)) return 'casing';
      if (/motorway|trunk|primary|highway/.test(id)) return 'roadMajor';
      if (/path|foot|pedestrian|track|cycle|steps/.test(id)) return 'path';
      if (/rail|transit|aeroway/.test(id)) return 'path';
      return 'roadMinor';
    }
    if (sl === 'landcover' || sl === 'landuse' || sl === 'park' || /park|green|wood|grass|forest|sand|pitch/.test(id)) return 'green';
    if (sl === 'boundary' || /boundary|admin/.test(id)) return 'dim';
    return 'land';
  }

  const COLOR_PROP = {
    background: 'background-color',
    fill: 'fill-color',
    line: 'line-color',
    circle: 'circle-color',
    'fill-extrusion': 'fill-extrusion-color'
  };

  function applyTheme(map, theme, showLabels) {
    if (!map.isStyleLoaded()) {
      map.once('idle', () => applyTheme(map, theme, showLabels));
      return;
    }
    const layers = map.getStyle().layers || [];
    for (const layer of layers) {
      if (String(layer.id).startsWith('fr-')) continue; // capas propias
      const kind = classify(layer);
      try {
        if (kind === 'label') {
          map.setLayoutProperty(layer.id, 'visibility', showLabels ? 'visible' : 'none');
          if (showLabels) {
            map.setPaintProperty(layer.id, 'text-color', theme.sub);
            map.setPaintProperty(layer.id, 'text-halo-color', theme.labelHalo);
            map.setPaintProperty(layer.id, 'text-halo-width', 1.4);
          }
          continue;
        }
        const prop = COLOR_PROP[layer.type];
        if (!prop) continue;

        let color;
        switch (kind) {
          case 'bg': color = theme.bg; break;
          case 'water': color = theme.water; break;
          case 'waterway': color = theme.waterway; break;
          case 'building': color = theme.building; break;
          case 'casing': color = theme.bg; break;
          case 'roadMajor': color = theme.roadMajor; break;
          case 'roadMinor': color = theme.roadMinor; break;
          case 'path': color = theme.path; break;
          case 'green': color = theme.green; break;
          case 'dim': color = theme.dim; break;
          default: color = theme.land;
        }
        map.setPaintProperty(layer.id, prop, color);

        if (kind === 'building') {
          if (layer.type === 'fill') {
            map.setPaintProperty(layer.id, 'fill-opacity', 1);
            map.setPaintProperty(layer.id, 'fill-outline-color', theme.buildingLine);
          }
        }
        if (kind === 'water') {
          if (layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-opacity', 1);
        }
      } catch (e) { /* capa sin esa propiedad: la saltamos */ }
    }
  }

  function ensureRouteLayers(map, theme) {
    if (!map.getSource('fr-route')) {
      map.addSource('fr-route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
    }
    if (!map.getLayer('fr-route-glow')) {
      map.addLayer({
        id: 'fr-route-glow',
        type: 'line',
        source: 'fr-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': theme.accent, 'line-width': 9, 'line-blur': 8, 'line-opacity': 0.35 }
      });
    }
    if (!map.getLayer('fr-route-line')) {
      map.addLayer({
        id: 'fr-route-line',
        type: 'line',
        source: 'fr-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': theme.accent, 'line-width': 2.4 }
      });
    }
  }

  function setRoute(map, coords, opts) {
    if (!map.getSource('fr-route')) return;
    const data = coords.length > 1
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] }
      : { type: 'FeatureCollection', features: [] };
    map.getSource('fr-route').setData(data);

    const vis = opts.show ? 'visible' : 'none';
    ['fr-route-glow', 'fr-route-line'].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    });
    if (map.getLayer('fr-route-line')) {
      map.setPaintProperty('fr-route-line', 'line-color', opts.theme.accent);
      map.setPaintProperty('fr-route-line', 'line-width', opts.width || 2.4);
      map.setPaintProperty('fr-route-line', 'line-dasharray', opts.dashed ? [1.6, 1.6] : [1, 0]);
    }
    if (map.getLayer('fr-route-glow')) {
      map.setPaintProperty('fr-route-glow', 'line-color', opts.theme.accent);
      map.setPaintProperty('fr-route-glow', 'line-width', (opts.width || 2.4) * 3.8);
    }
  }

  function create(container, opts) {
    const map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: opts.center || [-84.0663, 9.9395],
      zoom: opts.zoom != null ? opts.zoom : 12,
      bearing: opts.bearing || 0,
      pitch: 0,
      attributionControl: false,
      preserveDrawingBuffer: true, // imprescindible para toDataURL/toBlob
      fadeDuration: 0,
      maxPitch: 0
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: false }), 'top-right');
    return map;
  }

  /* ---------- pines en el editor (DOM) ---------- */

  function pinScale(stageWidthPx, userScale) {
    return (stageWidthPx / 1080) * (userScale || 1);
  }

  function buildPinElement(photo, index, theme, style, scale, thumbUrl) {
    const el = document.createElement('div');
    el.className = 'pin pin-' + style;
    const w = PIN.baseWidth * scale;

    if (style === 'photo') {
      const d = w * 1.55;
      el.style.width = d + 'px';
      el.style.height = (d + w * 0.34) + 'px';
      el.innerHTML = `
        <div class="pin-photo-ring" style="width:${d}px;height:${d}px;border-color:${theme.accent};border-width:${Math.max(1.5, w * 0.09)}px">
          ${thumbUrl ? `<img src="${thumbUrl}" alt="">` : ''}
        </div>
        <svg class="pin-tail" width="${w * 0.5}" height="${w * 0.36}" viewBox="0 0 10 7">
          <path d="M0 0 L10 0 L5 7 Z" fill="${theme.accent}"></path>
        </svg>`;
    } else if (style === 'dot') {
      const d = w * 0.52;
      el.style.width = d + 'px';
      el.style.height = d + 'px';
      el.innerHTML = `<div class="pin-core" style="width:${d}px;height:${d}px;background:${theme.accent};box-shadow:0 0 ${d}px ${theme.accent}66"></div>`;
    } else {
      const h = w * (PIN.vbH / PIN.vbW);
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      const inner = style === 'numbered'
        ? `<text x="12" y="16.2" text-anchor="middle" font-size="11" font-weight="700" font-family="ui-sans-serif,system-ui,sans-serif" fill="${theme.accentInk}">${index + 1}</text>`
        : `<circle cx="${PIN.holeCx}" cy="${PIN.holeCy}" r="${PIN.holeR}" fill="${theme.accentInk}"></circle>`;
      el.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 24 36">
          <path d="${PIN.path}" fill="${theme.accent}"></path>${inner}
        </svg>`;
    }
    el.title = photo.caption || photo.name || '';
    return el;
  }

  function pinAnchor(style) {
    return style === 'dot' ? 'center' : 'bottom';
  }

  window.MapView = {
    STYLE_URL, DEFAULT_STYLE, ATTRIB, PIN,
    create, applyTheme, ensureRouteLayers, setRoute,
    buildPinElement, pinAnchor, pinScale, classify
  };
})();
