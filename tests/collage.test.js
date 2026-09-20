/* Pruebas de la proyección y la colocación del collage.
   Sin dependencias:  node tests/collage.test.js  */
const Project = require('../collage/js/project.js');
const Layout = require('../collage/js/layout.js');
const Video = require('../collage/js/video.js');

let fallos = 0;
function comprobar(nombre, ok, detalle) {
  if (!ok) { fallos++; console.log('  FALLO', nombre, detalle == null ? '' : '->' + detalle); }
  else console.log('  OK  ', nombre);
}

console.log('\nProyección');
{
  const W = 1000, H = 1500;
  // Madrid, Toledo, Segovia: el triángulo real del viaje del usuario.
  const pts = [[-3.7038, 40.4168], [-4.0273, 39.8628], [-4.1088, 40.9429]];
  const p = Project.fit(pts, W, H, { padX: 0.1, padTop: 0.1, padBottom: 0.1 });
  const xy = pts.map(([lng, lat]) => p.project(lng, lat));

  comprobar('todos los puntos caen dentro del lienzo',
    xy.every(([x, y]) => x >= 0 && x <= W && y >= 0 && y <= H), JSON.stringify(xy.map(a => a.map(Math.round))));
  comprobar('y respetan el margen pedido',
    xy.every(([x, y]) => x >= W * 0.09 && x <= W * 0.91 && y >= H * 0.09 && y <= H * 0.91));
  comprobar('el norte queda arriba (Segovia por encima de Toledo)',
    xy[2][1] < xy[1][1], `${Math.round(xy[2][1])} vs ${Math.round(xy[1][1])}`);
  comprobar('el este queda a la derecha (Madrid a la derecha de Segovia)',
    xy[0][0] > xy[2][0]);

  // Todas las fotos en el mismo sitio: la escala no puede dispararse.
  const mismo = Project.fit([[-3.7, 40.4], [-3.7, 40.4]], W, H);
  const a = mismo.project(-3.7, 40.4);
  comprobar('un solo punto se centra sin reventar la escala',
    isFinite(a[0]) && isFinite(a[1]) && Math.abs(a[0] - W / 2) < 1, JSON.stringify(a));
  comprobar('sin puntos tampoco revienta', isFinite(Project.fit([], W, H).project(0, 0)[0]));

  // Ida y vuelta: proyectar e invertir tiene que devolver el mismo punto, o el
  // mapa de fondo quedaría desplazado respecto al collage.
  const rt = pts.map(([lng, lat]) => {
    const [x, y] = p.project(lng, lat);
    return p.invert(x, y);
  });
  comprobar('proyectar e invertir devuelve el punto original',
    rt.every((v, i) => Math.abs(v[0] - pts[i][0]) < 1e-9 && Math.abs(v[1] - pts[i][1]) < 1e-9),
    JSON.stringify(rt[0]));

  /* La cámara que se le pasa al mapa de tiles tiene que reproducir la misma
     escala: un grado de longitud debe medir los mismos píxeles en los dos. */
  const cam = p.camera(W, H);
  const mundoPx = 512 * Math.pow(2, cam.zoom);
  comprobar('el zoom equivalente reproduce la escala de la proyección',
    Math.abs(mundoPx - p.k) < 1e-6, `${mundoPx.toFixed(2)} vs ${p.k.toFixed(2)}`);
  const centro = p.project(cam.center[0], cam.center[1]);
  comprobar('y el centro de la cámara cae en el centro del lienzo',
    Math.abs(centro[0] - W / 2) < 1e-6 && Math.abs(centro[1] - H / 2) < 1e-6,
    JSON.stringify(centro.map((v) => +v.toFixed(3))));

  /* La cámara de captura, que es donde estuvo el fallo de verdad.

     El mapa no se pinta en un lienzo del tamaño del póster: se pinta en uno
     reducido por RATIO y se amplía por su pixelRatio. Comprobar la fórmula
     del zoom en el montaje fácil (contenedor a tamaño completo) daba cero de
     error y no servía de nada, porque el código real usaba el otro montaje y
     salía al doble de escala. Esta comprobación usa la fórmula de MapLibre
     sobre la cámara que se le pasa de verdad, con su ratio. */
  for (const ratio of [1, 2, 3]) {
    const cam = Project.captureCamera(p, W, H, ratio);
    const err = pts.map(([lng, lat]) => {
      const mio = p.project(lng, lat);
      const suyo = Project.posterPoint(cam, lng, lat, W, H, ratio);
      return Math.hypot(mio[0] - suyo[0], mio[1] - suyo[1]);
    });
    comprobar(`con ratio ${ratio} el mapa cae en el mismo píxel que el collage`,
      err.every((e) => e < 1e-6), err.map((e) => e.toFixed(1)).join(' / '));
    comprobar(`con ratio ${ratio} el contenedor se reduce en ese factor`,
      cam.cssW === Math.round(W / ratio) && cam.cssH === Math.round(H / ratio));
  }
  // Y el caso concreto que fallaba: a doble resolución, un zoom menos.
  comprobar('a doble resolución el zoom baja exactamente uno',
    Math.abs((p.camera(W, H).zoom - Project.captureCamera(p, W, H, 2).zoom) - 1) < 1e-12);

  const kmEnPx = mismo.pxPerKm(40.4);
  comprobar('pxPerKm da un número positivo y finito', kmEnPx > 0 && isFinite(kmEnPx));
}

console.log('\nColocación de piezas');
{
  const W = 1000, H = 1500;
  const proj = Project.fit([[-3.71, 40.41], [-3.69, 40.43]], W, H).project;

  /* El caso que hunde una colocación ingenua: treinta fotos en la misma plaza
     y tres repartidas. Puestas en su sitio exacto, las treinta se tapan. */
  const fotos = [];
  for (let i = 0; i < 30; i++) {
    fotos.push({ id: 'plaza' + i, lat: 40.4168 + (i % 5) * 0.00002, lng: -3.7038, weight: 1, aspect: 1.33 });
  }
  fotos.push({ id: 'lejos1', lat: 40.43, lng: -3.69, weight: 4, aspect: 1.33 });
  fotos.push({ id: 'lejos2', lat: 40.41, lng: -3.70, weight: 9, aspect: 0.75 });

  const piezas = Layout.build(fotos, proj, W, H, { baseSize: 0.12 });
  comprobar('salen tantas piezas como fotos', piezas.length === fotos.length);

  let solapeTotal = 0;
  for (let i = 0; i < piezas.length; i++) {
    for (let j = i + 1; j < piezas.length; j++) {
      const d = Math.hypot(piezas[i].x - piezas[j].x, piezas[i].y - piezas[j].y);
      if (d < 1) solapeTotal++;
    }
  }
  comprobar('ninguna pareja queda exactamente encima de otra', solapeTotal === 0, solapeTotal);

  const media = piezas.reduce((a, p) => a + Math.hypot(p.x - p.ax, p.y - p.ay), 0) / piezas.length;
  comprobar('el desplazamiento medio se mantiene acotado',
    media < piezas[0].r * 4, media.toFixed(1));
  comprobar('ninguna pieza supera su tope de desplazamiento',
    piezas.every((p) => p.drifted <= p.maxDrift + 0.5));
  comprobar('el tope se ensancha donde hay apiñamiento y no donde no lo hay',
    piezas.find((p) => p.id === 'plaza0').maxDrift > piezas.find((p) => p.id === 'lejos1').maxDrift);

  // La pieza de la parada con más fotos tiene que ser mayor que una suelta.
  const gorda = piezas.find((p) => p.id === 'lejos2');
  const flaca = piezas.find((p) => p.id === 'plaza0');
  comprobar('la parada con más fotos sale más grande',
    Math.max(gorda.w, gorda.h) > Math.max(flaca.w, flaca.h),
    `${Math.round(Math.max(gorda.w, gorda.h))} vs ${Math.round(Math.max(flaca.w, flaca.h))}`);

  // Sin peso, todas iguales.
  const iguales = Layout.build(fotos, proj, W, H, { baseSize: 0.12, sizeByWeight: 0 });
  const lados = iguales.map((p) => Math.round(Math.max(p.w, p.h)));
  comprobar('con el peso a cero todas las piezas miden lo mismo',
    new Set(lados).size === 1, JSON.stringify([...new Set(lados)]));

  // Determinismo: dos repintados seguidos no pueden barajar el collage.
  const otra = Layout.build(fotos, proj, W, H, { baseSize: 0.12 });
  comprobar('la colocación es determinista',
    otra.every((p, i) => Math.abs(p.x - piezas[i].x) < 1e-9 && Math.abs(p.rot - piezas[i].rot) < 1e-9));

  // La distorsión se mide en kilómetros, que es lo único que dice si el
  // collage sigue siendo un mapa.
  const pxKm = Project.fit([[-3.71, 40.41], [-3.69, 40.43]], W, H).pxPerKm(40.42);
  const tension = Layout.strain(piezas, pxKm);
  comprobar('strain mide el desplazamiento en kilómetros',
    tension.medianKm > 0 && tension.worstKm >= tension.medianKm,
    `${tension.medianKm.toFixed(2)} / ${tension.worstKm.toFixed(2)}`);
  comprobar('y también relativo al tamaño de la pieza, que es lo que se lee',
    tension.ratio > 0 && tension.worstRatio >= tension.ratio,
    `${tension.ratio.toFixed(2)} / ${tension.worstRatio.toFixed(2)}`);
  // Menos piezas del mismo tamaño tienen que deformar menos el mapa.
  const pocas = Layout.build(fotos.slice(0, 6), proj, W, H, { baseSize: 0.12 });
  comprobar('con menos piezas la deformación baja',
    Layout.strain(pocas, pxKm).ratio < tension.ratio,
    `${Layout.strain(pocas, pxKm).ratio.toFixed(2)} < ${tension.ratio.toFixed(2)}`);
  const sinMover = Layout.build([{ id: 'a', lat: 40.42, lng: -3.70, weight: 1 }], proj, W, H);
  comprobar('una foto sola no acumula distorsión',
    Layout.strain(sinMover, pxKm).medianKm < 1e-6);
  comprobar('sin escala no inventa una cifra', Layout.strain(piezas, 0).medianKm === 0);

  comprobar('sin fotos devuelve lista vacía', Layout.build([], proj, W, H).length === 0);
  comprobar('una foto sola no se mueve de su sitio', (() => {
    const una = Layout.build([{ id: 'a', lat: 40.42, lng: -3.70, weight: 1 }], proj, W, H);
    return una.length === 1 && una[0].drifted < 1e-6;
  })());

  // El aspecto real de la foto se respeta: una vertical no sale cuadrada.
  const vert = Layout.build([{ id: 'v', lat: 40.42, lng: -3.70, weight: 1, aspect: 0.75 }], proj, W, H)[0];
  comprobar('una foto vertical da una pieza vertical', vert.h > vert.w);
}

console.log('\nParadas lejanas');
{
  const Trips = require('../js/trips.js');
  const far = (l) => Layout.outliers(l, Trips.haversine).map((g) => g.id);

  /* El caso que dio la cara en un póster real: un viaje entero a Londres y una
     sola foto tomada en casa. El encuadre se abría 1283 km y el collage salía
     aplastado arriba, con el mapa enseñando el golfo de Vizcaya. */
  const londres = [];
  for (let i = 0; i < 24; i++) londres.push({ id: 'L' + i, lat: 51.5 + (i % 6) * 0.01, lng: -0.12 + (i % 5) * 0.015 });
  londres.push({ id: 'casa', lat: 40.4168, lng: -3.7038 });
  comprobar('una foto suelta a 1200 km se detecta como lejana',
    JSON.stringify(far(londres)) === '["casa"]', JSON.stringify(far(londres)));

  // Un viaje que de verdad recorre tres ciudades no tiene nada de anómalo.
  const esp = [];
  for (let i = 0; i < 8; i++) esp.push({ id: 'M' + i, lat: 40.4168 + i * 0.01, lng: -3.70 });
  for (let i = 0; i < 5; i++) esp.push({ id: 'T' + i, lat: 39.8628 + i * 0.01, lng: -4.02 });
  for (let i = 0; i < 5; i++) esp.push({ id: 'S' + i, lat: 40.9429 + i * 0.01, lng: -4.10 });
  comprobar('Madrid-Toledo-Segovia no marca ninguna parada como lejana',
    far(esp).length === 0, JSON.stringify(far(esp)));

  // Dos destinos a partes iguales son dos destinos, no una anomalía.
  const dos = [];
  for (let i = 0; i < 8; i++) dos.push({ id: 'A' + i, lat: 51.5 + i * 0.01, lng: -0.12 });
  for (let i = 0; i < 8; i++) dos.push({ id: 'B' + i, lat: 40.41 + i * 0.01, lng: -3.70 });
  comprobar('un viaje de dos destinos a medias no marca nada',
    far(dos).length === 0, JSON.stringify(far(dos)));

  comprobar('con muy pocas paradas no se aventura', far(londres.slice(0, 3)).length === 0);
  comprobar('sin lista no revienta', Layout.outliers(null, Trips.haversine).length === 0);
}

console.log('\nColocación en cuadrícula');
{
  const W = 1000, H = 1500;
  const proj = Project.fit([[-3.72, 40.40], [-3.68, 40.44]], W, H, { padX: 0.08, padTop: 0.08, padBottom: 0.08 });
  const fotos = [];
  for (let i = 0; i < 40; i++) {
    fotos.push({
      id: 'f' + i,
      lat: 40.40 + (i % 8) * 0.005,
      lng: -3.72 + Math.floor(i / 8) * 0.008,
      weight: 1 + (i % 5),
      aspect: i % 3 === 0 ? 0.75 : 1.5
    });
  }
  const cols = 10;
  const piezas = Layout.grid(fotos, proj.project, W, H, { cols });
  const cell = W / cols;

  comprobar('coloca piezas, pero no necesariamente todas (los huecos son el efecto)',
    piezas.length > 0 && piezas.length <= fotos.length, `${piezas.length} de ${fotos.length}`);

  comprobar('cada pieza cae alineada a la retícula',
    piezas.every((p) => {
      const x0 = p.x - p.w / 2, y0 = p.y - p.h / 2;
      return Math.abs(x0 / cell - Math.round(x0 / cell)) < 1e-6
        && Math.abs(y0 / cell - Math.round(y0 / cell)) < 1e-6;
    }));

  comprobar('el lado de cada bloque es un múltiplo entero de la celda',
    piezas.every((p) => Math.abs(p.w / cell - p.spanX) < 1e-6 && Math.abs(p.h / cell - p.spanY) < 1e-6));

  // Que dos bloques no compartan celda es la propiedad que hace legible la lámina.
  const ocupadas = new Set();
  let choque = false;
  for (const p of piezas) {
    for (let a = 0; a < p.spanX; a++) {
      for (let b = 0; b < p.spanY; b++) {
        const k = (p.col + a) + ':' + (p.row + b);
        if (ocupadas.has(k)) choque = true;
        ocupadas.add(k);
      }
    }
  }
  comprobar('ningún bloque pisa una celda ya ocupada', !choque);

  comprobar('ninguna pieza se sale del papel',
    piezas.every((p) => p.x - p.w / 2 >= -1e-6 && p.y - p.h / 2 >= -1e-6
      && p.x + p.w / 2 <= W + 1e-6 && p.y + p.h / 2 <= H + cell));

  comprobar('nadie se va más lejos del radio de búsqueda que se le permitió',
    piezas.every((p) => Math.abs(p.col - Math.floor(p.ax / cell)) <= 2
      && Math.abs(p.row - Math.floor(p.ay / cell)) <= 2));

  comprobar('las piezas salen en orden cronológico, que es lo que cose el hilo',
    piezas.every((p, i) => i === 0 || piezas[i - 1].order <= p.order));

  comprobar('conserva el punto geográfico real para poder manchar el mapa ahí',
    piezas.every((p) => isFinite(p.ax) && isFinite(p.ay)));

  comprobar('sin rotación: la retícula no se lee si las piezas van torcidas',
    piezas.every((p) => p.rot === 0));

  const otra = Layout.grid(fotos, proj.project, W, H, { cols });
  comprobar('la colocación es determinista',
    JSON.stringify(otra.map((p) => [p.id, p.col, p.row])) === JSON.stringify(piezas.map((p) => [p.id, p.col, p.row])));

  const gordas = piezas.filter((p) => p.spanX > 1 || p.spanY > 1);
  comprobar('las paradas con más peso consiguen bloque grande',
    gordas.length > 0 && gordas.every((p) => (p.photo.weight || 1) >= 3),
    `${gordas.length} bloques grandes`);

  // Menos columnas = celdas mayores = menos sitio: tienen que caer más fotos.
  const pocas = Layout.grid(fotos, proj.project, W, H, { cols: 4 });
  comprobar('con la retícula gruesa entran menos fotos y quedan más huecos',
    pocas.length < piezas.length, `${pocas.length} vs ${piezas.length}`);

  comprobar('sin fotos devuelve lista vacía', Layout.grid([], proj.project, W, H, { cols }).length === 0);

  const una = Layout.grid([{ id: 'u', lat: 40.42, lng: -3.70, weight: 1 }], proj.project, W, H, { cols });
  comprobar('una foto sola entra siempre', una.length === 1);

  const ret = Layout.gridLines(cols, W, H);
  comprobar('la retícula de referencia cubre todo el papel',
    ret.cols === cols && ret.rows * ret.cell >= H - 1e-6 && Math.abs(ret.cell - cell) < 1e-6);

  /* El corte del bloque grande sale del percentil de la distribución. Con
     pesos casi iguales, derivarlo del máximo daba bloque grande a tres de
     cada cuatro fotos y el ajuste no gobernaba nada. */
  const parejas = [];
  for (let i = 0; i < 36; i++) {
    parejas.push({ id: 'p' + i, lat: 40.40 + (i % 6) * 0.006, lng: -3.72 + Math.floor(i / 6) * 0.007,
      weight: 3 + (i % 2), aspect: 1.4 });
  }
  const conPeso = Layout.grid(parejas, proj.project, W, H, { cols, bigShare: 0.1 });
  const share = conPeso.filter((p) => p.spanX > 1 || p.spanY > 1).length / conPeso.length;
  comprobar('con pesos parecidos NO se agranda casi todo',
    share < 0.5, `${Math.round(share * 100)}% de bloques grandes`);
  comprobar('sin bloques grandes permitidos, todo es una celda',
    Layout.grid(parejas, proj.project, W, H, { cols, maxSpan: 1 })
      .every((p) => p.spanX === 1 && p.spanY === 1));
}

console.log('\nHuecos de la lámina');
{
  const W = 1000, H = 1500;
  const proj = Project.fit([[-3.73, 40.39], [-3.67, 40.45]], W, H, { padX: 0.06, padTop: 0.06, padBottom: 0.06 });
  // Un bloque macizo: 60 fotos repartidas por una malla apretada.
  const fotos = [];
  for (let i = 0; i < 60; i++) {
    fotos.push({ id: 'g' + i, lat: 40.40 + (i % 10) * 0.004, lng: -3.72 + Math.floor(i / 10) * 0.006, weight: 1 });
  }
  const opts = { cols: 12, maxSpan: 1 };
  const lleno = Layout.grid(fotos, proj.project, W, H, opts);
  const medio = Layout.grid(fotos, proj.project, W, H, Object.assign({ density: 0.5 }, opts));

  comprobar('la densidad recorta a la fracción pedida',
    medio.length === Math.round(lleno.length * 0.5), `${medio.length} de ${lleno.length}`);

  // Lo que importa no es cuántas quedan, es que se abran huecos DENTRO de la
  // mancha: el vecindario medio tiene que bajar, o sólo se habría recortado
  // por los bordes y la masa seguiría maciza.
  const vecindad = (lista) => {
    const set = new Set(lista.map((p) => p.col + ':' + p.row));
    let n = 0;
    for (const p of lista) {
      for (const [c, r] of [[p.col - 1, p.row], [p.col + 1, p.row], [p.col, p.row - 1], [p.col, p.row + 1]]) {
        if (set.has(c + ':' + r)) n++;
      }
    }
    return n / lista.length;
  };
  comprobar('quitar piezas abre huecos dentro de la mancha, no sólo en el borde',
    vecindad(medio) < vecindad(lleno) - 0.5,
    `${vecindad(lleno).toFixed(2)} -> ${vecindad(medio).toFixed(2)} vecinos de media`);

  comprobar('la disolución también es determinista',
    JSON.stringify(Layout.grid(fotos, proj.project, W, H, Object.assign({ density: 0.5 }, opts))
      .map((p) => p.id)) === JSON.stringify(medio.map((p) => p.id)));

  comprobar('al 100% no quita nada',
    Layout.grid(fotos, proj.project, W, H, Object.assign({ density: 1 }, opts)).length === lleno.length);

  comprobar('una densidad mínima deja al menos una pieza',
    Layout.grid(fotos, proj.project, W, H, Object.assign({ density: 0.001 }, opts)).length >= 1);
}


console.log('\nParadas de la cámara');
{
  /* Un viaje sintético con la forma que da problemas de verdad: una plaza con
     muchas fotos, una foto suelta lejos, otro sitio, y la vuelta a la plaza
     horas después. */
  const pts = [];
  const sitio = (x, y, n, t0) => {
    for (let i = 0; i < n; i++) pts.push({ x, y: y + i * 3, w: 120, h: 150, t: t0 + i * 60000 });
  };
  const MIN = 60000;
  sitio(300, 400, 25, 0);
  sitio(900, 700, 1, 90 * MIN);
  sitio(1200, 1500, 8, 200 * MIN);
  sitio(300, 400, 4, 600 * MIN);
  const W = 1600, H = 2400;
  const g = Video.paradas(pts, W, H, {});

  comprobar('las fotos del mismo sitio y rato hacen una sola parada',
    g.length === 4, g.map((x) => x.n).join('+'));
  comprobar('la plaza entera es una parada', g[0].n === 25);
  comprobar('una foto suelta lejos es su propia parada', g[1].n === 1);

  /* Lo que distingue un recorrido de un mapa: volver cuenta. Mismo sitio,
     misma caja, pero diez horas más tarde. */
  comprobar('volver al mismo sitio horas después es otra parada',
    g[3].n === 4 && Math.abs(g[3].cx - g[0].cx) < 1);

  comprobar('las paradas cubren todas las fotos, en orden y sin huecos',
    g[0].desde === 0 && g[g.length - 1].hasta === pts.length - 1
      && g.every((x, i) => i === 0 || x.desde === g[i - 1].hasta + 1));
  comprobar('y la cuenta de fotos cuadra',
    g.reduce((a, x) => a + x.n, 0) === pts.length);

  const tope = Video.paradas(pts, W, H, { tope: 2 });
  comprobar('el tope funde paradas hasta caber', tope.length === 2);
  comprobar('fundir no pierde ninguna foto',
    tope.reduce((a, x) => a + x.n, 0) === pts.length);
  comprobar('ni rompe el orden',
    tope[0].desde === 0 && tope[1].hasta === pts.length - 1
      && tope[1].desde === tope[0].hasta + 1);

  /* El tiempo por separado, sin que la distancia opine: el mismo sitio, la
     misma caja, dos ratos. Fotos de WhatsApp y capturas llegan sin fecha
     fiable, y entonces no hay nada por lo que partir. */
  const dosRatos = [];
  for (let i = 0; i < 6; i++) dosRatos.push({ x: 300, y: 400 + i * 3, w: 120, h: 150, t: i * MIN });
  for (let i = 0; i < 6; i++) dosRatos.push({ x: 300, y: 400 + i * 3, w: 120, h: 150, t: (600 + i) * MIN });
  comprobar('el mismo sitio en dos ratos distintos son dos paradas',
    Video.paradas(dosRatos, W, H, {}).length === 2);

  const sinFecha = dosRatos.map((q) => ({ x: q.x, y: q.y, w: q.w, h: q.h, t: 0 }));
  const sf = Video.paradas(sinFecha, W, H, {});
  comprobar('sin fechas no se parte por tiempo y queda una sola parada',
    sf.length === 1 && sf[0].n === dosRatos.length, sf.map((x) => x.n).join('+'));

  comprobar('sin fotos no revienta', Video.paradas([], W, H, {}).length === 0);
  comprobar('con una sola foto sale una parada',
    Video.paradas([pts[0]], W, H, {}).length === 1);
}

console.log('\nLínea de tiempo del vídeo');
{
  const caja = (desde, n) => ({ desde, hasta: desde + n - 1, n,
    x0: 0, x1: 200, y0: 0, y1: 200, cx: 100, cy: 100 });
  const grupos = [caja(0, 25), caja(25, 1), caja(26, 8), caja(34, 4)];
  const pl = Video.plan(grupos, { duracion: 18, cierre: 2.6, entrada: 0.4 });

  comprobar('el montaje acaba donde empieza el cierre',
    Math.abs(pl.montaje - (18 - 2.6)) < 1e-9, pl.montaje);
  comprobar('las fotos entran en orden',
    pl.inicio.every((v, i) => i === 0 || v >= pl.inicio[i - 1]));
  comprobar('la primera arranca en el segundo cero', pl.inicio[0] === 0);
  comprobar('la última acaba de entrar justo al cerrar el montaje',
    Math.abs((pl.inicio[pl.n - 1] + pl.entrada) - pl.montaje) < 1e-9,
    `${(pl.inicio[pl.n - 1] + pl.entrada).toFixed(3)} vs ${pl.montaje}`);

  const dur = pl.paradas.map((p) => p.fin - p.ini);
  comprobar('las paradas van seguidas y llenan el montaje',
    pl.paradas.every((p, i) => i === 0 || Math.abs(p.ini - pl.paradas[i - 1].fin) < 1e-9)
      && Math.abs(pl.paradas[pl.paradas.length - 1].fin - pl.montaje) < 1e-9);

  /* El reparto va con la raíz del número de fotos, no proporcional: con 25
     fotos frente a 1, lo proporcional daría 25 veces más tiempo y la foto
     suelta pasaría en dos fotogramas. */
  comprobar('una parada con muchas fotos dura más que una de una sola',
    dur[0] > dur[1]);
  comprobar('pero no proporcionalmente más',
    dur[0] / dur[1] < 8, `${(dur[0] / dur[1]).toFixed(1)} veces`);

  comprobar('la entrada nunca dura más que la parada más corta',
    pl.entrada <= Math.min.apply(null, dur));

  const fin = Video.estado(pl, pl.duracion);
  comprobar('al terminar están todas puestas y ninguna entrando',
    fin.firmes === pl.n && fin.vuelo.length === 0 && fin.traza === 1);
  comprobar('al empezar el plano general ya está todo puesto',
    Video.estado(pl, pl.montaje).firmes === pl.n);
  comprobar('en el segundo cero no hay nada puesto',
    Video.estado(pl, 0).firmes === 0 && Video.estado(pl, 0).vuelo.length === 0);

  let coherente = true, retrocede = false, previo = 0;
  for (let t = 0; t <= pl.duracion; t += 0.05) {
    const st = Video.estado(pl, t);
    if (st.firmes < previo) retrocede = true;
    previo = st.firmes;
    for (const v of st.vuelo) {
      if (v.i < st.firmes || v.alpha <= 0 || v.alpha > 1 || t < pl.inicio[v.i]) coherente = false;
    }
  }
  comprobar('las fotos nunca desaparecen una vez puestas', !retrocede);
  comprobar('las que entran lo hacen a su hora y con opacidad válida', coherente);

  const solo = Video.plan([caja(0, 1)], { duracion: 8 });
  comprobar('con una sola foto no revienta', Video.estado(solo, 8).firmes === 1);
  const apretado = Video.plan(grupos, { duracion: 7, cierre: 99 });
  comprobar('un cierre exagerado se recorta y deja montaje',
    apretado.montaje > 0 && Video.estado(apretado, apretado.duracion).firmes === apretado.n);
}

console.log('\nRecorrido de la cámara');
{
  const W = 1200, H = 1800, ACERCA = 2.2;
  const caja = (desde, n, cx, cy) => ({ desde, hasta: desde + n - 1, n, cx, cy,
    x0: cx - 90, x1: cx + 90, y0: cy - 110, y1: cy + 110 });
  const grupos = [caja(0, 10, 150, 200), caja(10, 4, 1000, 1600), caja(14, 6, 600, 900)];
  const pl = Video.plan(grupos, { duracion: 16, cierre: 2.6, apertura: 1.3 });

  const fin = Video.camara(pl, pl.duracion, W, H, ACERCA);
  comprobar('acaba enseñando la lámina entera',
    Math.abs(fin.sw - W) < 1e-6 && Math.abs(fin.sh - H) < 1e-6
      && fin.sx === 0 && fin.sy === 0, JSON.stringify(fin));

  /* Lo que pidió el usuario: que la cámara siga a las fotos. Estando quieta en
     una parada, su caja tiene que caer dentro del encuadre. */
  let enfoca = true;
  pl.paradas.forEach((p, i) => {
    const t = p.ini + (p.fin - p.ini) * 0.8;   // ya parada, sin moverse
    const c = Video.camara(pl, t, W, H, ACERCA);
    const g = grupos[i];
    if (g.x0 < c.sx - 1 || g.x1 > c.sx + c.sw + 1
      || g.y0 < c.sy - 1 || g.y1 > c.sy + c.sh + 1) enfoca = false;
  });
  comprobar('en cada parada su grupo cae dentro del encuadre', enfoca);

  const a = Video.camara(pl, pl.paradas[0].ini + (pl.paradas[0].fin - pl.paradas[0].ini) * 0.7, W, H, ACERCA);
  const b = Video.camara(pl, pl.paradas[1].ini + (pl.paradas[1].fin - pl.paradas[1].ini) * 0.7, W, H, ACERCA);
  comprobar('y dos paradas distintas se miran desde sitios distintos',
    Math.hypot(a.sx - b.sx, a.sy - b.sy) > W * 0.1);

  /* Quieta en el tramo final de la parada: si la cámara no para nunca, el
     vídeo parece grabado a pulso y no da tiempo a mirar ninguna foto. */
  const p0 = pl.paradas[0];
  const q1 = Video.camara(pl, p0.ini + (p0.fin - p0.ini) * 0.6, W, H, ACERCA);
  const q2 = Video.camara(pl, p0.ini + (p0.fin - p0.ini) * 0.95, W, H, ACERCA);
  comprobar('la cámara se queda quieta en el tramo final de cada parada',
    Math.abs(q1.sx - q2.sx) < 1e-6 && Math.abs(q1.sw - q2.sw) < 1e-6);

  let dentro = true, proporcion = true, cerca = true;
  for (let t = 0; t <= pl.duracion; t += 0.04) {
    const c = Video.camara(pl, t, W, H, ACERCA);
    if (c.sx < -1e-9 || c.sy < -1e-9 || c.sx + c.sw > W + 1e-9 || c.sy + c.sh > H + 1e-9) dentro = false;
    if (Math.abs((c.sw / c.sh) - (W / H)) > 1e-9) proporcion = false;
    // Nunca más cerca de lo pedido, o la lámina saldría ampliada y borrosa.
    if (c.sw < W / ACERCA - 1e-6) cerca = false;
  }
  comprobar('el encuadre nunca se sale de la lámina', dentro);
  comprobar('la proporción del recorte es siempre la de la lámina', proporcion);
  comprobar('nunca se acerca más de lo pedido', cerca);

  const sin = Video.camara(pl, 3, W, H, 1);
  comprobar('sin acercamiento el encuadre es la lámina entera',
    sin.sx === 0 && sin.sy === 0 && sin.sw === W && sin.sh === H);

  /* El marco y el título son mobiliario de la lámina impresa: de cerca salen
     partidos, así que no se imprimen hasta que el plano se abre. */
  comprobar('el mobiliario de la lámina no se ve durante el recorrido',
    Video.remate(pl, 0) === 0 && Video.remate(pl, pl.montaje * 0.99) === 0);
  comprobar('y está entero al acabar', Video.remate(pl, pl.duracion) === 1);
  let sube = true, prev = -1;
  for (let t = 0; t <= pl.duracion; t += 0.02) {
    const r = Video.remate(pl, t);
    if (r < prev - 1e-9 || r < 0 || r > 1) sube = false;
    prev = r;
  }
  comprobar('y aparece de una vez, sin ir y venir', sube);
}

console.log(fallos ? `\n${fallos} comprobaciones fallidas` : '\nTodo correcto');
process.exit(fallos ? 1 : 0);
