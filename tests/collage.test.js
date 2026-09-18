/* Pruebas de la proyección y la colocación del collage.
   Sin dependencias:  node tests/collage.test.js  */
const Project = require('../collage/js/project.js');
const Layout = require('../collage/js/layout.js');

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

console.log(fallos ? `\n${fallos} comprobaciones fallidas` : '\nTodo correcto');
process.exit(fallos ? 1 : 0);
