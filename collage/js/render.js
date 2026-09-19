/* Dibujo del póster completo.

   Una sola función dibuja tanto la vista previa como la imagen que se
   descarga; solo cambia el tamaño del lienzo. En la otra herramienta el editor
   es HTML y el exportador es canvas, y mantenerlos iguales costó trabajo y un
   fallo de posición de pines. Aquí no puede pasar: es el mismo código. */
(function () {

  const MONO = '"SF Mono", ui-monospace, Menlo, Consolas, monospace';
  const SERIF = 'Georgia, "Times New Roman", serif';

  // Piezas ya recortadas y enmascaradas. Reconstruirlas en cada repintado hace
  // que mover un deslizador vaya a tirones; la clave incluye el tamaño, así que
  // al exportar se rehacen a resolución alta, que es lo que se quiere.
  const cache = new Map();
  const MAX_CACHE = 260;
  function cacheGet(key, make) {
    let v = cache.get(key);
    if (v) return v;
    v = make();
    if (cache.size > MAX_CACHE) cache.clear();
    cache.set(key, v);
    return v;
  }
  function clearCache() { cache.clear(); }

  function tornPath(ctx, w, h, seed, amount) {
    const r = Paper.rnd(seed);
    const steps = 44;
    const jitter = Math.min(w, h) * 0.055 * amount;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // Recorrido del perímetro de un rectángulo, con el borde temblando.
      let x, y;
      if (t < 0.25) { x = -w / 2 + (t / 0.25) * w; y = -h / 2; }
      else if (t < 0.5) { x = w / 2; y = -h / 2 + ((t - 0.25) / 0.25) * h; }
      else if (t < 0.75) { x = w / 2 - ((t - 0.5) / 0.25) * w; y = h / 2; }
      else { x = -w / 2; y = h / 2 - ((t - 0.75) / 0.25) * h; }
      const nx = x + (r() - 0.5) * jitter;
      const ny = y + (r() - 0.5) * jitter;
      if (i === 0) ctx.moveTo(nx, ny); else ctx.lineTo(nx, ny);
    }
    ctx.closePath();
  }

  /* Dibuja la imagen cubriendo la caja (como background-size: cover): si se
     encaja entera quedan franjas de papel y el collage deja de ser continuo. */
  function drawCover(ctx, img, w, h) {
    const iw = img.width, ih = img.height;
    const s = Math.max(w / iw, h / ih);
    const dw = iw * s, dh = ih * s;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  }

  function makePatch(piece, s, w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(w));
    c.height = Math.max(2, Math.round(h));
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.imageSmoothingQuality = 'high';

    const style = s.shape;
    if (style === 'polaroid') {
      const pad = Math.min(c.width, c.height) * 0.055;
      ctx.fillStyle = '#f7f4ec';
      ctx.fillRect(-c.width / 2, -c.height / 2, c.width, c.height);
      ctx.save();
      ctx.beginPath();
      ctx.rect(-c.width / 2 + pad, -c.height / 2 + pad, c.width - pad * 2, c.height - pad * 2.6);
      ctx.clip();
      drawCover(ctx, piece.img, c.width - pad * 2, c.height - pad * 2.6);
      ctx.restore();
    } else if (style === 'rasgado') {
      ctx.save();
      tornPath(ctx, c.width * 0.97, c.height * 0.97, piece.seed, 1);
      ctx.clip();
      drawCover(ctx, piece.img, c.width, c.height);
      ctx.restore();
    } else if (style === 'recorte') {
      drawCover(ctx, piece.img, c.width, c.height);
    } else { // mancha: el borde se deshace, que es lo que funde unas con otras
      drawCover(ctx, piece.img, c.width, c.height);
      /* La máscara tiene que ser elíptica, no circular: en una foto apaisada
         un degradado circular deja el interior opaco solo en una franja
         central y la pieza sale como una nube y no como una foto.
         El núcleo opaco es amplio a propósito: si se difumina desde el centro,
         la nube entera pierde la imagen y queda una acuarela sin motivo. */
      const core = Math.min(0.95, Math.max(0.15, 1 - s.bleed * 0.8));
      ctx.globalCompositeOperation = 'destination-in';
      ctx.save();
      ctx.scale(c.width / 2, c.height / 2);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(core, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();
    }
    return c;
  }

  /* Mancha de mapa: la foto tiñe las calles y edificios reales de alrededor
     de donde se tomó. Se pinta en el punto geográfico verdadero de la pieza
     (p.ax, p.ay), no en su posición ya empujada por la física de separación
     (p.x, p.y): si una foto del Louvre acaba desplazada dos manzanas para no
     tapar a su vecina, lo que tiene que mancharlo sigue siendo el punto real,
     o la mancha cae donde no toca. Va borrosa, en tono de la tinta y con
     mezcla "multiply": tiñe lo que ya hay dibujado en vez de tapar lo, que es
     lo que distingue una mancha de una pegatina. */
  function makeStainPatch(piece, size, ink) {
    const w = Math.max(2, Math.round(size));
    const c = document.createElement('canvas');
    c.width = w; c.height = w;
    const ctx = c.getContext('2d');
    ctx.translate(w / 2, w / 2);
    ctx.filter = `blur(${Math.round(w * 0.06)}px) saturate(0.6) contrast(0.9)`;
    drawCover(ctx, piece.img, w, w);
    ctx.filter = 'none';

    // Máscara radial: se ve el centro, el borde se disuelve en las calles.
    ctx.globalCompositeOperation = 'destination-in';
    ctx.save();
    ctx.scale(w / 2, w / 2);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, 'rgba(0,0,0,0.85)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.5)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();

    // Un barniz de la tinta del papel: sin esto la mancha mete un color de
    // foto que no pega con la lámina.
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = ink.ink;
    ctx.globalAlpha = 0.22;
    ctx.fillRect(-w / 2, -w / 2, w, w);

    return c;
  }

  function mapStains(ctx, W, H, model, s, ink) {
    if (!model.base || s.mapStrength <= 0 || !s.mapStain) return;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    for (const p of model.pieces) {
      if (!p.img) continue;
      const size = p.w * 2.4;
      const key = `stain|${p.id}|${Math.round(size)}|${s.ink}`;
      const patch = cacheGet(key, () => makeStainPatch(p, size, ink));
      ctx.save();
      ctx.globalAlpha = s.mapStain;
      ctx.translate(p.ax, p.ay);
      ctx.drawImage(patch, -patch.width / 2, -patch.height / 2);
      ctx.restore();
    }
    ctx.restore();
  }

  /* Halo alrededor de la traza: no es un mapa real, es lo que hace que el
     papel vacío no parezca un error. Anillos cada vez más tenues, como las
     curvas de nivel de un plano dibujado a mano. */
  function halo(ctx, track, ink, W, strength) {
    if (!track || track.length < 2 || strength <= 0) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = ink;
    const rings = 5;
    for (let i = rings; i >= 1; i--) {
      ctx.globalAlpha = 0.05 * strength * (1 - (i - 1) / rings);
      ctx.lineWidth = (W * 0.006) * i * 2.4;
      ctx.beginPath();
      ctx.moveTo(track[0][0], track[0][1]);
      for (let k = 1; k < track.length; k++) ctx.lineTo(track[k][0], track[k][1]);
      ctx.stroke();
    }
    ctx.restore();
  }

  function polyline(ctx, pts, color, width, alpha, dash) {
    if (!pts || pts.length < 2) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.restore();
  }

  function textBlock(ctx, W, H, m, s, ink) {
    const u = W / 100;
    const cx = W / 2;

    /* Banda de papel bajo los textos. Sin ella, una pieza que caiga abajo se
       come el título, y eso no se puede arreglar solo con márgenes: el collage
       sigue la geografía y no hay forma de saber de antemano si habrá una foto
       justo ahí. La banda es papel, así que parece el pie de una lámina
       montada, no un parche. */
    /* Con marco, todo el bloque de texto sube: si no, el pie se cruza con el
       filete y parece un error de imprenta. */
    const fr = s.frame ? 4.2 * u : 0;
    const band = H * (m.title || m.subtitle || m.meta ? 0.24 : 0.10) + fr;
    const g = ctx.createLinearGradient(0, H - band, 0, H);
    g.addColorStop(0, Paper.rgba(ink.paper, 0));
    g.addColorStop(0.45, Paper.rgba(ink.paper, 0.88));
    g.addColorStop(1, Paper.rgba(ink.paper, 1));
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, H - band, W, band);
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    let y = H - 5.2 * u - fr;
    if (s.showFooter && m.footer) {
      ctx.font = `400 ${1.25 * u}px ${MONO}`;
      ctx.fillStyle = ink.mid;
      ctx.fillText(m.footer, cx, H - 2.6 * u - fr);
    }

    if (m.meta) {
      ctx.font = `400 ${1.5 * u}px ${MONO}`;
      ctx.fillStyle = ink.mid;
      ctx.fillText(m.meta, cx, y);
      y -= 3.4 * u;
    }

    if (m.subtitle) {
      ctx.font = `400 ${1.9 * u}px ${MONO}`;
      ctx.fillStyle = ink.mid;
      const txt = m.subtitle.toUpperCase();
      ctx.save();
      ctx.letterSpacing = `${0.28 * u}px`;
      ctx.fillText(txt, cx, y);
      ctx.restore();
      y -= 3.2 * u;
    }

    if (m.title) {
      /* El título va como escrito a mano bajo una foto montada: serif, grande
         y sin interletrado exagerado. El póster de la otra herramienta es
         tipografía de neón; este es un cuaderno. */
      let size = 6.4 * u * (s.titleScale || 1);
      ctx.font = `400 ${size}px ${SERIF}`;
      const maxW = W * 0.84;
      let w = ctx.measureText(m.title).width;
      if (w > maxW) {
        size *= maxW / w;
        ctx.font = `400 ${size}px ${SERIF}`;
      }
      ctx.fillStyle = ink.ink;
      ctx.fillText(m.title, cx, y);
      y -= size * 0.55;

      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = ink.mid;
      ctx.lineWidth = Math.max(1, 0.12 * u);
      ctx.beginPath();
      ctx.moveTo(cx - 9 * u, y);
      ctx.lineTo(cx + 9 * u, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* Marco de lámina: doble filete con un respiro de papel por fuera. Es lo que
     convierte "un mapa con fotos encima" en "una lámina enmarcada", y además
     recorta el mapa de fondo para que no llegue crudo hasta el borde. */
  function frame(ctx, W, H, ink, s) {
    if (!s.frame) return;
    const u = W / 100;
    const m = 4.2 * u;
    ctx.save();
    ctx.fillStyle = ink.paper;
    ctx.fillRect(0, 0, W, m);
    ctx.fillRect(0, H - m, W, m);
    ctx.fillRect(0, 0, m, H);
    ctx.fillRect(W - m, 0, m, H);

    ctx.strokeStyle = ink.mid;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = Math.max(1, 0.16 * u);
    ctx.strokeRect(m, m, W - m * 2, H - m * 2);
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = Math.max(1, 0.07 * u);
    ctx.strokeRect(m * 1.45, m * 1.45, W - m * 2.9, H - m * 2.9);
    ctx.restore();
  }

  function marks(ctx, W, H, ink, on) {
    if (!on) return;
    const u = W / 100;
    const m = 3.2 * u, len = 2.2 * u;
    ctx.save();
    ctx.strokeStyle = ink.mid;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(1, 0.09 * u);
    const corner = (x, y, sx, sy) => {
      ctx.beginPath();
      ctx.moveTo(x, y + sy * len); ctx.lineTo(x, y);
      ctx.lineTo(x + sx * len, y);
      ctx.stroke();
    };
    corner(m, m, 1, 1);
    corner(W - m, m, -1, 1);
    corner(m, H - m, 1, -1);
    corner(W - m, H - m, -1, -1);
    ctx.restore();
  }

  /* Capa de pintura.

     Esto es lo que separa un collage de veinticuatro fotos borrosas sueltas.
     Dibujadas directamente sobre el papel, el borde difuminado de cada pieza
     se funde con el PAPEL, no con la foto de al lado: salen manchas aisladas
     flotando. Dibujadas primero en un lienzo transparente, ese mismo borde se
     funde con lo que ya hay pintado, que es la vecina. El interior de la nube
     queda continuo y solo el contorno exterior se desvanece contra el papel,
     que es exactamente lo que hace que las fotos pinten el mapa. */
  function paintLayer(W, H, model, s) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    /* En la lámina de atlas la pieza es el recorte exacto de la celda: ni
       borde rasgado ni giro ni sombra. Lo que se lee ahí es la retícula, y
       basta con que una pieza sobresalga un milímetro para romperla. */
    const atlas = s.layout === 'atlas';
    const ps = atlas ? Object.assign({}, s, { shape: 'recorte' }) : s;
    for (const p of model.pieces) {
      if (!p.img) continue;
      const key = `${p.id}|${ps.shape}|${Math.round(p.w)}x${Math.round(p.h)}|${s.bleed.toFixed(2)}`;
      const patch = cacheGet(key, () => makePatch(p, ps, p.w, p.h));
      ctx.save();
      ctx.translate(p.x, p.y);
      if (!atlas) ctx.rotate(p.rot * (s.rotation ? 1 : 0));
      ctx.globalAlpha = s.pieceAlpha;
      if (!atlas && s.shadow > 0 && s.shape !== 'mancha') {
        ctx.shadowColor = `rgba(0,0,0,${0.35 * s.shadow})`;
        ctx.shadowBlur = W * 0.008 * s.shadow;
        ctx.shadowOffsetY = W * 0.002 * s.shadow;
      }
      ctx.drawImage(patch, -patch.width / 2, -patch.height / 2);
      ctx.restore();
    }
    return c;
  }

  /* Retícula de la lámina.

     Es la pieza que convierte un mosaico de fotos en un dibujo: líneas de
     construcción que siguen por todo el papel, también donde no hay nada. Se
     dibuja dos veces, antes y después de las fotos. La de debajo es la que se
     ve en los huecos; la de encima, casi invisible, cruza los recortes y los
     ata al mismo sistema en vez de dejarlos flotando. */
  function reticula(ctx, W, H, ink, s, alpha) {
    if (!s.gridLines || alpha <= 0) return;
    const g = Layout.gridLines(s.gridCols, W, H);
    ctx.save();
    ctx.strokeStyle = ink.mid;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(0.5, W / 2600);
    ctx.beginPath();
    for (let c = 0; c <= g.cols; c++) {
      const x = Math.round(c * g.cell) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
    }
    for (let r = 0; r <= g.rows; r++) {
      const y = Math.round(r * g.cell) + 0.5;
      ctx.moveTo(0, y); ctx.lineTo(W, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* Aparato cartográfico: barra de escala, norte y la cruz del sitio. No son
     adorno; son lo que declara que esto se lee como un plano y no como una
     página de álbum, y lo que permite medir de un vistazo cuánto abarca. */
  function cartouche(ctx, W, H, ink, s, model) {
    if (!s.cartouche) return;
    const u = W / 100;
    const m = (s.frame ? 6.4 : 3.2) * u;
    ctx.save();
    ctx.strokeStyle = ink.mid;
    ctx.fillStyle = ink.mid;
    ctx.lineWidth = Math.max(1, 0.08 * u);

    // Norte: flecha mínima arriba a la derecha.
    const nx = W - m, ny = m + 2 * u;
    ctx.beginPath();
    ctx.moveTo(nx, ny + 2.4 * u);
    ctx.lineTo(nx, ny - 1.6 * u);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(nx, ny - 2.4 * u);
    ctx.lineTo(nx - 0.65 * u, ny - 1.1 * u);
    ctx.lineTo(nx + 0.65 * u, ny - 1.1 * u);
    ctx.closePath();
    ctx.fill();
    ctx.font = `400 ${1.2 * u}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText('N', nx, ny + 4 * u);

    /* Barra de escala: se elige un número redondo de kilómetros y se mide
       cuánto ocupa, no al revés. Una barra de "2,37 km" no la lee nadie. */
    if (model.pxPerKm > 0) {
      const objetivo = W * 0.16 / model.pxPerKm;      // km que cabrían
      const pot = Math.pow(10, Math.floor(Math.log10(Math.max(objetivo, 1e-6))));
      const km = [1, 2, 5, 10].map((n) => n * pot).filter((n) => n <= objetivo * 1.4)
        .pop() || pot;
      const len = km * model.pxPerKm;
      if (isFinite(len) && len > 4 && len < W * 0.5) {
        /* Arriba a la izquierda, no abajo: abajo está la banda del título y la
           barra caía justo encima del pie, medio tapada por él. Aquí además
           hace pareja con el norte de la esquina opuesta. */
        const bx = m, by = m + 2.4 * u;
        ctx.beginPath();
        ctx.moveTo(bx, by - 0.7 * u); ctx.lineTo(bx, by);
        ctx.lineTo(bx + len, by); ctx.lineTo(bx + len, by - 0.7 * u);
        ctx.stroke();
        // Mitad rellena: el truco de siempre para leerla sin regla.
        ctx.fillRect(bx, by - 0.22 * u, len / 2, 0.22 * u);
        ctx.font = `400 ${1.15 * u}px ${MONO}`;
        ctx.textAlign = 'left';
        ctx.fillText(km >= 1 ? `${km} km` : `${Math.round(km * 1000)} m`, bx, by + 1.8 * u);
      }
    }
    ctx.restore();
  }

  /* El hilo que cose las piezas. Va por debajo de la pintura salvo que se pida
     lo contrario: encima, en un viaje que va y vuelve por la misma ciudad, se
     convierte en una maraña de líneas cruzadas que tapa el collage. Por debajo
     asoma entre las fotos y se lee como una costura. */
  function thread(ctx, model, s, ink, W) {
    const pts = model.route;
    if (!pts || pts.length < 2) return;
    const w = Math.max(1, W * 0.0026 * s.routeWidth);

    /* Dentro de una misma ciudad las fotos consecutivas en el tiempo están
       desperdigadas, así que unirlas todas en orden cronológico dibuja una
       maraña que cruza el collage entero y lo tapa. Con "solo saltos largos"
       el hilo enseña el viaje (una ciudad a otra) y se calla el zigzag local,
       que de todas formas ya lo cuenta la traza fina de debajo. */
    let min = 0;
    if (s.routeLongOnly) {
      /* Umbral adaptado a los datos, no una fracción fija del papel: en un
         viaje entre ciudades el salto típico son decenas de píxeles y el
         traslado son cientos, pero en un viaje dentro de una sola ciudad esas
         cifras son otras. Varias veces el salto mediano separa "el traslado"
         de "la vuelta de la esquina" en ambos casos. */
      const hops = [];
      for (let i = 1; i < pts.length; i++) {
        hops.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      }
      hops.sort((a, b) => a - b);
      const med = hops[Math.floor(hops.length / 2)] || 0;
      min = Math.max(W * 0.05, med * 1.55);
    }
    const tramos = [];
    let cur = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (d < min) { cur = [pts[i]]; continue; }
      cur.push(pts[i]);
      if (cur.length === 2) { tramos.push(cur); cur = [pts[i]]; }
    }
    for (const t of tramos) {
      polyline(ctx, t, ink.accent, w, s.routeAbove ? 0.8 : 1,
        s.routeDashed ? [w * 2.6, w * 2.2] : null);
    }

    // Los nudos sí van en todas las piezas: marcan dónde estuviste aunque el
    // hilo entre dos vecinas no se dibuje.
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = ink.accent;
    for (const pt of pts) {
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], w * 1.2, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }

  /* model: { pieces, track, route, title, subtitle, meta, footer }
     settings: aspecto visual completo. */
  function render(ctx, W, H, model, s) {
    const ink = window.INKS[s.ink] || window.INKS.cianotipo;
    ctx.save();
    ctx.clearRect(0, 0, W, H);

    Paper.base(ctx, W, H, { paper: ink.paper, ink: ink.ink, texture: s.texture });

    /* El mapa va lo primero: es el contexto sobre el que se pega todo lo
       demás. Con opacidad parcial se lee como una lámina impresa debajo, no
       como una captura de pantalla con fotos encima. */
    if (model.base && s.mapStrength > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, s.mapStrength);
      ctx.drawImage(model.base, 0, 0, W, H);
      ctx.restore();
    }

    mapStains(ctx, W, H, model, s, ink);

    reticula(ctx, W, H, ink, s, 0.5);

    halo(ctx, model.track, ink.mid, W, s.halo);

    if (s.showTrack) {
      /* La traza es el recorrido real, punto por punto. Antes iba tan tenue
         que el póster se quedaba sin recorrido en cuanto el hilo se recortaba;
         va por debajo de las fotos, así que puede permitirse ser visible. */
      polyline(ctx, model.track, ink.accent, Math.max(1, W * 0.0026 * s.trackWidth), 0.75 * s.trackOpacity);
    }

    if (s.showRoute && !s.routeAbove) thread(ctx, model, s, ink, W);

    /* Revelado del fondo, antes de pegar las fotos.

       El duotono lava todo lo que encuentra, y aplicado al final se lleva por
       delante el color de las fotos: ese es el motivo de que la lámina saliera
       siempre en sepia. Revelando solo el fondo —papel, mapa y traza— la base
       queda como un grabado monocromo y los recortes se pegan encima con su
       color intacto, que es exactamente cómo está hecha una lámina de estas. */
    const fondoAparte = s.duotoneScope === 'fondo';
    if (fondoAparte) {
      Paper.develop(ctx, W, H, {
        paper: ink.paper, ink: ink.ink,
        duotone: s.duotone, contrast: s.contrast, brightness: s.brightness,
        grain: 0, seed: 20260918
      });
    }

    ctx.save();
    // Sobreimpresión: multiplicar pieza a pieza sobre un lienzo transparente
    // daría negro; lo que se multiplica es la capa entera contra el papel.
    if (s.blend === 'multiply') ctx.globalCompositeOperation = 'multiply';
    /* La saturación se aplica al componer la capa entera, no píxel a píxel:
       un filtro de canvas cuesta una fracción y aquí puede haber 260 piezas. */
    if (fondoAparte && s.photoColor !== 1) ctx.filter = `saturate(${Math.max(0, s.photoColor)})`;
    ctx.drawImage(paintLayer(W, H, model, s), 0, 0);
    ctx.restore();

    if (s.showRoute && s.routeAbove) thread(ctx, model, s, ink, W);

    // La retícula vuelve a pasar por encima, ya casi transparente: ata los
    // recortes al mismo sistema en vez de dejarlos flotando sobre el papel.
    reticula(ctx, W, H, ink, s, 0.16);

    if (s.numbered) {
      const u = W / 100;
      ctx.save();
      ctx.font = `400 ${1.5 * u}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      model.pieces.forEach((p, i) => {
        const x = p.x + p.w * 0.36, y = p.y + p.h * 0.36;
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = ink.paper;
        ctx.beginPath();
        ctx.arc(x, y, 1.35 * u, 0, 6.2832);
        ctx.fill();
        ctx.fillStyle = ink.ink;
        ctx.fillText(String(i + 1), x, y + 0.08 * u);
      });
      ctx.restore();
    }

    textBlock(ctx, W, H, model, s, ink);

    /* El marco va antes del revelado para que el margen reciba el mismo grano
       y el mismo duotono que el resto: si se dibuja después, queda una orla
       lisa alrededor de un papel con textura y se nota al instante. */
    frame(ctx, W, H, ink, s);

    /* Si el fondo ya se reveló aparte, al final solo pasa el grano: es lo que
       unifica foto y papel bajo la misma trama de impresión. Sin esta segunda
       pasada los recortes se notan pegados, como un montaje digital. */
    Paper.develop(ctx, W, H, fondoAparte
      ? { paper: ink.paper, ink: ink.ink, duotone: 0, contrast: 1, brightness: 0,
          grain: s.grain * 0.7, seed: 20260918 }
      : { paper: ink.paper, ink: ink.ink,
          duotone: s.duotone, contrast: s.contrast, brightness: s.brightness,
          grain: s.grain, seed: 20260918 });
    Paper.grime(ctx, W, H, { grime: s.grime });
    cartouche(ctx, W, H, ink, s, model);
    marks(ctx, W, H, ink, s.marks);

    ctx.restore();
  }

  window.Render = { render, clearCache, MONO, SERIF };
})();
