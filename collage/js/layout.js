/* Colocación de las piezas del collage.

   El problema de verdad no es dibujar fotos sobre un lienzo: es que las fotos
   de un viaje no están repartidas, están amontonadas. En un viaje normal hay
   treinta fotos de una plaza y una sola en los veinte kilómetros siguientes.
   Puestas en su sitio exacto, las treinta se tapan entre sí y el resto del
   lienzo queda vacío: ni se ve el collage ni se entiende el recorrido.

   La solución es una relajación con muelle: las piezas que se solapan se
   empujan, y a la vez cada una tira hacia su posición geográfica real. El
   desplazamiento está limitado, así que el resultado sigue siendo un mapa,
   no una composición inventada. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Layout = api;
}(typeof self !== 'undefined' ? self : this, function () {

  const DEFAULTS = {
    baseSize: 0.16,     // lado mayor de la pieza, en fracción del ancho del lienzo
    sizeByWeight: 0.55, // cuánto agranda una parada con muchas fotos (0 = todas iguales)
    separation: 0.82,   // 1 = sin solape; por debajo, las piezas se muerden (eso pinta)
    drift: 1.6,         // desplazamiento máximo permitido, en radios de pieza
    iterations: 90,
    rotation: 5,        // grados de giro máximo
    seed: 7
  };

  // RNG determinista: el mismo collage tiene que salir igual en cada repintado,
  // o mover un deslizador cualquiera baraja todas las fotos.
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function hashId(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* photos: [{ id, lat, lng, takenAt, weight, aspect }]
     project: (lng, lat) -> [x, y]  */
  function build(photos, project, canvasW, canvasH, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const list = photos.filter((p) => p && p.lat != null && p.lng != null);
    if (!list.length) return [];

    const maxWeight = list.reduce((m, p) => Math.max(m, p.weight || 1), 1);
    const base = o.baseSize * canvasW;

    const pieces = list.map((p, i) => {
      const [ax, ay] = project(p.lng, p.lat);
      const seed = hashId(String(p.id || i)) ^ (o.seed * 2654435761);
      const rand = rng(seed);
      /* El peso entra en logaritmo: si no, una parada con 80 fotos se come el
         póster y las paradas de una sola foto desaparecen. */
      const wRatio = Math.log1p((p.weight || 1) - 1) / Math.log1p(Math.max(1, maxWeight - 1) || 1);
      const scale = 1 + o.sizeByWeight * (isFinite(wRatio) ? wRatio : 0);
      const aspect = p.aspect && isFinite(p.aspect) && p.aspect > 0 ? p.aspect : 1;
      const long = base * scale;
      const w = aspect >= 1 ? long : long * aspect;
      const h = aspect >= 1 ? long / aspect : long;
      return {
        id: p.id, photo: p,
        ax, ay, x: ax, y: ay,
        w, h,
        r: Math.hypot(w, h) / 2 * o.separation,
        rot: (rand() * 2 - 1) * o.rotation * Math.PI / 180,
        seed: seed >>> 0,
        order: i
      };
    });

    /* Tope de desplazamiento por pieza, no global. Treinta fotos del mismo
       patio no caben dentro de radio y medio por mucho que se empujen: con un
       tope fijo, once parejas acababan exactamente una encima de otra y once
       fotos desaparecían del collage sin que nada avisara. El tope crece con
       la raíz del apiñamiento, que es justo el área que necesitan. El muelle
       sigue tirando, así que se quedan tan cerca de su sitio como permita la
       geometría: el tope solo deja de ser la causa de que se tapen. */
    for (const a of pieces) {
      let crowd = 0;
      for (const b of pieces) {
        if (a === b) continue;
        if (Math.hypot(b.ax - a.ax, b.ay - a.ay) < (a.r + b.r) * 1.2) crowd++;
      }
      a.crowd = crowd;
      a.maxDrift = a.r * o.drift * Math.sqrt(1 + crowd);
    }

    relax(pieces, o);

    for (const pc of pieces) {
      pc.drifted = Math.hypot(pc.x - pc.ax, pc.y - pc.ay);
    }
    return pieces;
  }

  function relax(pieces, o) {
    const n = pieces.length;
    if (n < 2) return;
    const pull = 0.12;
    for (let it = 0; it < o.iterations; it++) {
      for (let i = 0; i < n; i++) {
        const a = pieces[i];
        for (let j = i + 1; j < n; j++) {
          const b = pieces[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          const min = a.r + b.r;
          if (d >= min) continue;
          if (d < 1e-6) {
            // Dos fotos en la misma coordenada exacta: hay que romper el empate
            // con algo determinista, o se quedan pegadas para siempre.
            const ang = ((a.seed ^ b.seed) % 628) / 100;
            dx = Math.cos(ang); dy = Math.sin(ang); d = 1;
          }
          const push = (min - d) / 2 / d;
          a.x -= dx * push; a.y -= dy * push;
          b.x += dx * push; b.y += dy * push;
        }
      }
      // Muelle hacia la posición real, con tope duro de desplazamiento.
      for (const p of pieces) {
        p.x += (p.ax - p.x) * pull;
        p.y += (p.ay - p.y) * pull;
        const dx = p.x - p.ax, dy = p.y - p.ay;
        const d = Math.hypot(dx, dy);
        const max = p.maxDrift != null ? p.maxDrift : p.r * o.drift;
        if (d > max) {
          p.x = p.ax + dx / d * max;
          p.y = p.ay + dy / d * max;
        }
      }
    }
  }

  /* Colocación en cuadrícula.

     La otra colocación empuja piezas hasta que dejan de solaparse, y el
     resultado es un amasijo continuo: bonito, pero se come el mapa. Esta hace
     lo contrario. Divide el papel en celdas iguales y mete cada foto en la
     celda que le toca por coordenadas, recortada al cuadrado. Lo que hace que
     una lámina así se lea no son las fotos: son los huecos. Por eso, cuando la
     celda que toca está ocupada, solo se busca sitio a un par de celdas de
     distancia, y si no lo hay la foto se queda fuera. Empujarla más lejos
     llenaría el papel y mataría justo el efecto que se busca.

     El span (cuántas celdas ocupa un bloque) va por peso: una parada de
     cuarenta fotos merece un bloque de 2×2 y una de paso, una celda. Es el
     ritmo irregular de las láminas de atlas, no un mosaico uniforme. */
  function grid(photos, project, canvasW, canvasH, opts) {
    const o = Object.assign({
      cols: 12,
      search: 2,        // celdas de radio máximo para buscar hueco
      bigShare: 0.12,   // fracción de piezas que aspiran a bloque grande
      density: 1,       // fracción de las colocadas que se conserva
      maxSpan: 2,
      seed: 7
    }, opts);
    const list = photos.filter((p) => p && p.lat != null && p.lng != null);
    if (!list.length) return [];

    const cols = Math.max(1, Math.round(o.cols));
    const cell = canvasW / cols;
    const rows = Math.max(1, Math.ceil(canvasH / cell));

    const placed = [];
    const taken = new Set();
    const key = (c, r) => c + ':' + r;
    const free = (c, r, sx, sy) => {
      if (c < 0 || r < 0 || c + sx > cols || r + sy > rows) return false;
      for (let i = 0; i < sx; i++) {
        for (let j = 0; j < sy; j++) if (taken.has(key(c + i, r + j))) return false;
      }
      return true;
    };

    /* Las piezas se colocan de más pesada a menos: la parada importante elige
       celda antes y se queda con la que de verdad le corresponde; las de paso
       se acomodan en lo que sobre o se caen de la lámina. Al revés, una foto
       cualquiera ocuparía el sitio de la que da sentido al viaje. */
    const order = list.map((p, i) => {
      const [px, py] = project(p.lng, p.lat);
      return { p, i, px, py, w: p.weight || 1 };
    }).sort((a, b) => (b.w - a.w) || (a.i - b.i));

    /* Cuántos bloques grandes: un cupo, no un umbral de peso.

       Con umbral, cualquier viaje donde media docena de paradas empate en el
       peso alto se lleva bloque grande entera —la mitad de la lámina— y el
       ajuste no gobierna nada. Un cupo sobre la lista ya ordenada por peso da
       la proporción exacta que se pide, sea cual sea la forma de los datos.

       Con una condición: para optar a bloque grande hay que estar por encima
       de la mediana. Si todas las paradas pesan lo mismo, ninguna merece más
       sitio que otra, y un ritmo uniforme es la respuesta honesta. */
    const pesos = list.map((p) => p.weight || 1).sort((a, b) => a - b);
    const mediana = pesos[Math.floor(pesos.length / 2)];
    const share = Math.max(0, Math.min(1, o.bigShare));
    let cupoGrande = Math.floor(list.length * share);
    let cupoMedio = Math.floor(list.length * share * 1.5);

    for (const item of order) {
      const { p, i, px, py } = item;
      if (!isFinite(px) || !isFinite(py)) continue;
      const c0 = Math.floor(px / cell);
      const r0 = Math.floor(py / cell);

      /* El bloque grande se intenta primero y se cae a una celda si no cabe:
         es preferible que la foto entre pequeña a que se pierda por no haber
         sitio para el tamaño que "merecía". */
      const aspect = p.aspect && isFinite(p.aspect) && p.aspect > 0 ? p.aspect : 1;
      const wants = [];
      const destaca = o.maxSpan >= 2 && item.w > mediana;
      let gastaGrande = false, gastaMedio = false;
      if (destaca && cupoGrande > 0) {
        wants.push([2, 2]);
        wants.push(aspect >= 1 ? [2, 1] : [1, 2]);
        gastaGrande = true;
      } else if (destaca && cupoMedio > 0) {
        wants.push(aspect >= 1 ? [2, 1] : [1, 2]);
        gastaMedio = true;
      }
      wants.push([1, 1]);

      let spot = null;
      for (const [sx, sy] of wants) {
        // Anillos crecientes alrededor de la celda que toca por geografía.
        for (let rad = 0; rad <= o.search && !spot; rad++) {
          for (let dr = -rad; dr <= rad && !spot; dr++) {
            for (let dc = -rad; dc <= rad && !spot; dc++) {
              if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
              if (free(c0 + dc, r0 + dr, sx, sy)) spot = { c: c0 + dc, r: r0 + dr, sx, sy };
            }
          }
        }
        if (spot) break;
      }
      if (!spot) continue;   // sin hueco cerca: se queda fuera, y está bien

      // El cupo se gasta al colocar, no al pedir: una pieza que aspiraba a
      // bloque grande y acabó en una celda no debe consumir el cupo de otra.
      if (spot.sx > 1 || spot.sy > 1) {
        if (gastaGrande) cupoGrande--; else if (gastaMedio) cupoMedio--;
      }

      for (let a = 0; a < spot.sx; a++) {
        for (let b = 0; b < spot.sy; b++) taken.add(key(spot.c + a, spot.r + b));
      }
      const w = spot.sx * cell;
      const h = spot.sy * cell;
      placed.push({
        id: p.id, photo: p,
        ax: px, ay: py,
        x: spot.c * cell + w / 2,
        y: spot.r * cell + h / 2,
        w, h,
        col: spot.c, row: spot.r, spanX: spot.sx, spanY: spot.sy,
        r: Math.min(w, h) / 2,
        rot: 0,
        seed: hashId(String(p.id || i)) >>> 0,
        order: i
      });
    }

    const final = o.density < 1 ? disolver(placed, o.density) : placed;

    // Se devuelven en el orden original (cronológico), que es el que necesita
    // el hilo del recorrido; la prioridad por peso solo servía para repartir.
    final.sort((a, b) => a.order - b.order);
    for (const pc of final) pc.drifted = Math.hypot(pc.x - pc.ax, pc.y - pc.ay);
    return final;
  }

  /* Abrir huecos donde la retícula se ha llenado de golpe.

     Colocar y ya está no basta: las fotos de un viaje se apiñan en cuatro
     sitios, así que la retícula sale con cuatro manchas macizas y el resto del
     papel vacío. Eso no es una lámina, es un mosaico con márgenes. Lo que hace
     legible una lámina es el damero, y el damero se consigue quitando.

     Se retira siempre la pieza con más vecinos ocupados, o sea la que está más
     enterrada en una mancha, y se recuenta después de cada retirada. Quitar al
     azar deja la mancha igual de maciza y abre agujeros donde ya había aire. */
  function disolver(placed, density) {
    const objetivo = Math.max(1, Math.round(placed.length * Math.max(0, Math.min(1, density))));
    if (placed.length <= objetivo) return placed;

    const vivos = placed.slice();
    const celdas = (p) => {
      const out = [];
      for (let a = 0; a < p.spanX; a++) {
        for (let b = 0; b < p.spanY; b++) out.push([p.col + a, p.row + b]);
      }
      return out;
    };

    while (vivos.length > objetivo) {
      const ocupadas = new Set();
      for (const p of vivos) for (const [c, r] of celdas(p)) ocupadas.add(c + ':' + r);

      let peor = -1, peorScore = -1;
      for (let i = 0; i < vivos.length; i++) {
        const p = vivos[i];
        const propias = new Set(celdas(p).map(([c, r]) => c + ':' + r));
        let vecinos = 0;
        for (const [c, r] of celdas(p)) {
          const alrededor = [[c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1]];
          for (const [vc, vr] of alrededor) {
            const k = vc + ':' + vr;
            if (!propias.has(k) && ocupadas.has(k)) vecinos++;
          }
        }
        /* Desempates deterministas y con criterio: entre dos igual de
           enterradas cae antes la de menos peso, y si también empatan, la
           posterior en el tiempo. Sin esto el resultado bailaría en cada
           repintado y el collage se barajaría solo al mover un deslizador. */
        const score = vecinos * 1e6 + (1e3 - Math.min(999, p.photo.weight || 1)) * 1e2 + (p.order % 100);
        if (score > peorScore) { peorScore = score; peor = i; }
      }
      if (peor < 0) break;
      vivos.splice(peor, 1);
    }
    return vivos;
  }

  /* Rejilla de referencia: las líneas que se dibujan sobre todo el papel, no
     solo donde hay fotos. Es lo que convierte un mosaico en una lámina. */
  function gridLines(cols, canvasW, canvasH) {
    const n = Math.max(1, Math.round(cols));
    const cell = canvasW / n;
    return { cell, cols: n, rows: Math.max(1, Math.ceil(canvasH / cell)) };
  }

  /* Cuánto se ha tenido que mentir para que quepa. Es la cifra honesta de si
     el collage sigue siendo un mapa: si la mitad de las piezas está en su
     tope de desplazamiento, la densidad elegida es demasiado alta. */
  /* Cuánto se ha tenido que mentir para que quepa.

     La primera versión de esto contaba cuántas piezas estaban en su tope de
     desplazamiento, y siempre daba cero: como el tope se ensancha con el
     apiñamiento, nunca se toca. Medía la elasticidad de mi propio límite, no
     la distorsión del mapa. Lo que importa es en kilómetros: si una foto
     aparece a doce kilómetros de donde se tomó, el collage ha dejado de ser
     un mapa, y eso hay que decirlo en vez de que se descubra al mirar. */
  function strain(pieces, pxPerKm) {
    if (!pieces.length || !pxPerKm) return { medianKm: 0, worstKm: 0, share: 0 };
    const km = pieces.map((p) => p.drifted / pxPerKm).sort((a, b) => a - b);
    let atLimit = 0;
    for (const p of pieces) {
      const max = p.maxDrift != null ? p.maxDrift : p.r * DEFAULTS.drift;
      if (p.drifted > max * 0.95) atLimit++;
    }
    /* La cifra que de verdad decide si el mapa se lee es el desplazamiento
       comparado con el tamaño de la propia pieza. En un viaje de 120 km una
       pieza ya mide 13 km de ancho, así que "corrida 30 km" suena a desastre
       y puede ser medio dedo en el papel; y en un paseo por un barrio, 300 m
       de corrimiento lo destroza. El cociente vale para los dos casos. */
    const ratios = pieces.map((p) => (p.r > 0 ? p.drifted / p.r : 0)).sort((a, b) => a - b);
    return {
      medianKm: km[Math.floor(km.length / 2)],
      worstKm: km[km.length - 1],
      ratio: ratios[Math.floor(ratios.length / 2)],
      worstRatio: ratios[ratios.length - 1],
      share: atLimit / pieces.length
    };
  }

  /* Paradas muy lejos del resto.

     Una foto suelta a mil kilómetros no es un fallo del programa, pero arruina
     el póster: el encuadre se abre hasta ella y el collage queda aplastado en
     una esquina con el resto del papel vacío. Conviene decirlo, porque desde
     el póster no se adivina la causa.

     Se usa la mediana y no la media porque este es justo el caso en que la
     media miente: un valor extremo la arrastra y entonces ya nada parece
     extremo. Las tres condiciones son necesarias —muy por encima de lo
     habitual, lejos en términos absolutos, y en minoría— para no llamar
     anómalo a un viaje que de verdad recorre medio país.

     dist(aLat, aLng, bLat, bLng) -> km */
  function outliers(list, dist, opts) {
    const o = Object.assign({ factor: 6, floorKm: 50, maxShare: 0.35, minList: 4 }, opts);
    if (!list || list.length < o.minList) return [];
    const mid = (arr) => {
      const s2 = arr.slice().sort((x, y) => x - y);
      return s2[Math.floor(s2.length / 2)];
    };
    const cLat = mid(list.map((g) => g.lat));
    const cLng = mid(list.map((g) => g.lng));
    const d = list.map((g) => dist(cLat, cLng, g.lat, g.lng));
    const limit = Math.max(mid(d) * o.factor, o.floorKm);
    const far = list.filter((g, i) => d[i] > limit);
    return far.length && far.length <= list.length * o.maxShare ? far : [];
  }

  return { build, grid, gridLines, relax, strain, outliers, rng, hashId, DEFAULTS };
}));
