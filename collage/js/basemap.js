/* Mapa de fondo, como contexto bajo el collage.

   El collage por sí solo dice dónde estuviste en relación contigo mismo, pero
   no dónde está eso en el mundo: un cuaderno precioso sin pie de foto. Esto
   pone debajo un mapa real, redibujado como grabado a tinta sobre el papel,
   para que se reconozcan la costa, los ríos y las calles.

   Lo delicado no es pintarlo, es cuadrarlo: el mapa y el collage tienen que
   compartir proyección al píxel, o una foto acabaría en la calle de al lado.
   Como los dos son Mercator, basta con igualar escala y centro, que es lo que
   calcula Project.camera(). */
(function () {
  const RATIO = 2;          // el mapa se pinta al doble y se reduce: sale nítido
  const LOAD_MS = 12000;   // sin conexión no tiene sentido esperar más

  function mix(a, b, t) {
    const [ar, ag, ab] = Paper.hex(a), [br, bg, bb] = Paper.hex(b);
    const c = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
    return '#' + c(ar, br) + c(ag, bg) + c(ab, bb);
  }

  /* Paleta de mapa derivada de la tinta del póster. Las paletas de la otra
     herramienta son de neón sobre negro; aquí todo tiene que parecer impreso
     sobre el mismo papel, así que se construye mezclando papel y tinta. */
  function paperTheme(ink) {
    return {
      bg: ink.paper,
      land: ink.paper,
      /* Estas mezclas van más cargadas de lo que parece necesario a simple
         vista: el mapa se dibuja luego con opacidad parcial y encima pasa el
         revelado, que lo lava otra vez. Con mezclas suaves el mapa acababa
         siendo un fantasma gris que no aportaba contexto ninguno. */
      green: mix(ink.paper, ink.ink, 0.11),
      water: mix(ink.paper, ink.ink, 0.26),
      waterway: mix(ink.paper, ink.ink, 0.44),
      building: mix(ink.paper, ink.ink, 0.17),
      buildingLine: mix(ink.paper, ink.ink, 0.3),
      roadMajor: mix(ink.paper, ink.ink, 0.64),
      roadMinor: mix(ink.paper, ink.ink, 0.38),
      path: mix(ink.paper, ink.ink, 0.26),
      dim: mix(ink.paper, ink.ink, 0.45),
      accent: ink.accent,
      title: ink.ink,
      sub: ink.mid,
      labelHalo: ink.paper
    };
  }

  /* Paleta de línea: el mapa como plano dibujado, no como mapa impreso.

     Aquí no hay manchas de color: el suelo, los parques y los edificios se
     quedan en el papel, y lo único que queda dibujado son las calles, la
     costa y los ríos. Es la diferencia entre poner una captura de mapa debajo
     del collage y poner un plano: con relleno, cada hueco de la retícula es
     un cuadrado gris; sin relleno, el hueco enseña el trazado y el papel
     respira, que es lo que hace legible una lámina así. */
  function wireTheme(ink) {
    const t = paperTheme(ink);
    return Object.assign(t, {
      green: ink.paper,
      land: ink.paper,
      building: ink.paper,
      buildingLine: mix(ink.paper, ink.ink, 0.22),
      water: mix(ink.paper, ink.ink, 0.09),
      waterway: mix(ink.paper, ink.ink, 0.5),
      roadMajor: mix(ink.paper, ink.ink, 0.58),
      roadMinor: mix(ink.paper, ink.ink, 0.34),
      path: mix(ink.paper, ink.ink, 0.22),
      dim: mix(ink.paper, ink.ink, 0.4)
    });
  }

  /* Adelgazar el trazo. El tema solo cambia colores, y una autopista de ocho
     píxeles en color tenue sigue siendo una mancha alargada: para que se lea
     como línea de plano hay que tocar el grosor, que es lo que hace esto. */
  function thinLines(map) {
    const layers = (map.getStyle().layers || []);
    for (const layer of layers) {
      if (String(layer.id).startsWith('fr-')) continue;
      try {
        if (layer.type === 'line') {
          map.setPaintProperty(layer.id, 'line-width', [
            'interpolate', ['linear'], ['zoom'], 6, 0.35, 12, 0.7, 16, 1.2
          ]);
          map.setPaintProperty(layer.id, 'line-blur', 0);
        } else if (layer.type === 'fill') {
          const sl = String(layer['source-layer'] || '').toLowerCase();
          const esAgua = sl === 'water' || /water|ocean|sea|lake/.test(String(layer.id).toLowerCase());
          map.setPaintProperty(layer.id, 'fill-opacity', esAgua ? 0.55 : 0);
          if (esAgua) map.setPaintProperty(layer.id, 'fill-outline-color', mix('#000000', '#ffffff', 0.5));
        } else if (layer.type === 'fill-extrusion') {
          map.setPaintProperty(layer.id, 'fill-extrusion-opacity', 0);
        }
      } catch (e) { /* capa sin esa propiedad: se salta */ }
    }
  }

  function waitFor(map, evt, ms) {
    return new Promise((res) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; res(false); } }, ms);
      map.once(evt, () => { if (!done) { done = true; clearTimeout(t); res(true); } });
    });
  }

  /* Una captura en curso a la vez. Sin esto, arrastrar un deslizador deja
     media docena de mapas de MapLibre vivos a la vez y el navegador se queda
     sin contextos WebGL (el límite ronda los 16 y no avisa: deja de pintar). */
  let pending = null;

  async function capture(opts) {
    if (typeof maplibregl === 'undefined') return null;
    if (pending) { try { await pending; } catch (e) { /* da igual cómo fuera */ } }
    const job = doCapture(opts);
    pending = job.catch(() => null);
    try { return await job; } finally { pending = null; }
  }

  async function doCapture({ W, H, fit, ink, labels, wire }) {
    const cam = Project.captureCamera(fit, W, H, RATIO);
    const { center, zoom, cssW, cssH } = cam;
    const host = document.createElement('div');
    host.style.cssText = `position:absolute;left:-20000px;top:0;width:${cssW}px;height:${cssH}px;`;
    document.body.appendChild(host);

    let map = null;
    try {
      map = new maplibregl.Map({
        container: host,
        style: MapView.STYLE_URL,
        center, zoom,
        bearing: 0, pitch: 0,
        interactive: false,
        attributionControl: false,
        preserveDrawingBuffer: true,
        fadeDuration: 0
      });
      /* Se le pide al mapa la resolución que hace falta en vez de parchear el
         devicePixelRatio de la página. Parchearlo funciona, pero deja la
         variable global equivocada mientras dura la captura, y aquí se captura
         cada vez que cambia el encuadre: cualquier otro dibujo que ocurriera
         en esos segundos saldría al tamaño que no es. */
      if (typeof map.setPixelRatio === 'function') map.setPixelRatio(RATIO);

      if (!(await waitFor(map, 'load', LOAD_MS))) return null;
      MapView.applyTheme(map, wire ? wireTheme(ink) : paperTheme(ink), !!labels);
      if (wire) thinLines(map);
      await waitFor(map, 'idle', LOAD_MS);
      // Dos cuadros de gracia: 'idle' llega antes de que el último se pinte.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const src = map.getCanvas();
      if (!src.width || !src.height) return null;
      const out = document.createElement('canvas');
      out.width = W; out.height = H;
      const ctx = out.getContext('2d');
      ctx.fillStyle = ink.paper;
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(src, 0, 0, src.width, src.height, 0, 0, W, H);
      out.dataset.src = src.width + 'x' + src.height;
      return out;
    } catch (e) {
      return null;
    } finally {
      if (map) { try { map.remove(); } catch (e) { /* ya estaba fuera */ } }
      host.remove();
    }
  }

  window.Basemap = {
    capture, paperTheme, wireTheme, mix,
    get available() { return typeof maplibregl !== 'undefined'; }
  };
})();
