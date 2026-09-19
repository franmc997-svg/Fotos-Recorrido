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

  return { build, relax, strain, outliers, rng, hashId, DEFAULTS };
}));
