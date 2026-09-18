/* Proyección y encuadre.

   Esta herramienta no lleva mapa base: la geografía sale de dónde están las
   fotos, no de unos tiles. Aun así las posiciones tienen que ser correctas, o
   el collage deja de ser un recorrido y pasa a ser un mural decorativo. Web
   Mercator es la misma proyección que usan los mapas de calle, así que las
   formas coinciden con lo que la gente reconoce. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Project = api;
}(typeof self !== 'undefined' ? self : this, function () {

  // Mercator normalizado a [0,1]. La y va hacia abajo, como el canvas.
  function merc(lng, lat) {
    const x = (lng + 180) / 360;
    const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
    const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    return [x, y];
  }

  /* Encuadra los puntos en un lienzo de w×h dejando un margen. Devuelve la
     función de proyección y la escala, que hace falta para saber cuántos
     píxeles mide un kilómetro (las piezas del collage se dimensionan así). */
  function fit(points, w, h, opts) {
    const o = Object.assign({ padX: 0.1, padTop: 0.1, padBottom: 0.1, minSpan: 1e-5 }, opts);
    const pts = points.filter((p) => p && isFinite(p[0]) && isFinite(p[1]));
    const boxW = w * (1 - o.padX * 2);
    const boxH = h * (1 - o.padTop - o.padBottom);
    const cx = w / 2;
    const cy = h * o.padTop + boxH / 2;

    if (!pts.length) {
      const k = Math.min(boxW, boxH);
      return make(0.5, 0.5, k, cx, cy);
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      const [x, y] = merc(p[0], p[1]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    /* Un viaje entero dentro de una plaza tiene extensión casi cero: sin este
       mínimo la escala se dispara y todo sale a distancias absurdas. */
    const spanX = Math.max(maxX - minX, o.minSpan);
    const spanY = Math.max(maxY - minY, o.minSpan);
    const k = Math.min(boxW / spanX, boxH / spanY);
    return make((minX + maxX) / 2, (minY + maxY) / 2, k, cx, cy);
  }

  // Inversa de merc: hace falta para decirle a un mapa real dónde centrarse.
  function unmerc(x, y) {
    const lng = x * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
    return [lng, lat];
  }

  function make(centerX, centerY, k, cx, cy) {
    const project = (lng, lat) => {
      const [x, y] = merc(lng, lat);
      return [cx + (x - centerX) * k, cy + (y - centerY) * k];
    };
    const invert = (px, py) => unmerc(centerX + (px - cx) / k, centerY + (py - cy) / k);
    /* Píxeles por km en el centro del encuadre. Mercator estira con la
       latitud, así que esto es una aproximación local; para dimensionar
       piezas de collage sobra. */
    const pxPerKm = (lat) => {
      const rad = Math.cos(Math.max(-85, Math.min(85, lat)) * Math.PI / 180);
      return (k / 40075.017) * rad;
    };
    /* Cámara equivalente para un mapa de tiles. MapLibre mide el mundo en
       512·2^z píxeles CSS; k son los píxeles que ocupa el mundo entero en mi
       proyección, así que el zoom sale de igualar ambas cifras. El centro es
       simplemente el punto que mi proyección coloca en el medio del lienzo:
       si los dos coinciden en escala y en centro, y los dos son Mercator,
       coinciden en todos los puntos. Sin esto el mapa y el collage estarían
       desplazados y las fotos caerían en la calle equivocada. */
    const camera = (W, H) => ({
      center: invert(W / 2, H / 2),
      zoom: Math.log2(k / 512)
    });
    return { project, invert, camera, pxPerKm, k, cx, cy, center: [centerX, centerY] };
  }

  return { merc, unmerc, fit };
}));
