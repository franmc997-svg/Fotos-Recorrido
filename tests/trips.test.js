/* Prueba de la detección de viajes sobre un carrete sintético.
   No necesita dependencias:  node tests/trips.test.js  */
const Trips = require('../js/trips.js');

const H = 3600000, D = 86400000;
let seed = 42;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

const HOME = { lat: 9.9281, lng: -84.0907 };
const T0 = Date.UTC(2023, 0, 5, 12);
const recs = [];
let id = 0;
const push = (lat, lng, ts, gps = true) => recs.push({
  idx: id++, name: `IMG_${String(id).padStart(4, '0')}.HEIC`, kind: 'heic',
  lat: gps ? lat + (rnd() - 0.5) * 0.004 : null,
  lng: gps ? lng + (rnd() - 0.5) * 0.004 : null,
  takenAt: ts
});

// 400 días de vida normal en casa
for (let d = 0; d < 400; d++) {
  const n = 1 + Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) push(HOME.lat, HOME.lng, T0 + d * D + i * 2 * H);
}

const VIAJES = [
  { nombre: 'Guanacaste', dia: 40, dias: 5, lat: 10.63, lng: -85.44, porDia: 55 },
  { nombre: 'Panamá', dia: 120, dias: 8, lat: 8.98, lng: -79.52, porDia: 70 },
  { nombre: 'México', dia: 250, dias: 12, lat: 19.43, lng: -99.13, porDia: 90 },
  { nombre: 'Monteverde', dia: 330, dias: 2, lat: 10.30, lng: -84.82, porDia: 40 }
];
for (const v of VIAJES) {
  for (let d = 0; d < v.dias; d++) {
    for (let i = 0; i < v.porDia; i++) {
      const parada = Math.floor(i / (v.porDia / 4));
      push(v.lat + parada * 0.012, v.lng + parada * 0.015,
           T0 + (v.dia + d) * D + 8 * H + i * 10 * 60000,
           rnd() > 0.35); // 35% sin GPS, como en un carrete real
    }
  }
}

let fallos = 0;
function comprobar(nombre, cond, detalle) {
  if (cond) {
    console.log('  OK   ' + nombre);
  } else {
    console.log('  FALLA ' + nombre + (detalle ? ' — ' + detalle : ''));
    fallos++;
  }
}

console.log(`Carrete sintético: ${recs.length} fotos, ${recs.filter(r => r.lat == null).length} sin GPS`);

const home = Trips.detectHome(recs);
comprobar('detecta la residencia', !!home);
comprobar('la residencia cae donde toca',
  home && Trips.haversine(home.lat, home.lng, HOME.lat, HOME.lng) < 1,
  home && Trips.haversine(home.lat, home.lng, HOME.lat, HOME.lng).toFixed(2) + ' km');

const trips = Trips.detect(recs);
comprobar('encuentra exactamente los 4 viajes plantados', trips.length === 4, 'salieron ' + trips.length);

// una foto suelta tomada en casa en mitad de un viaje no debe partirlo
const conIntruso = recs.concat([{ idx: 99999, name: 'intrusa.jpg', kind: 'jpeg',
  lat: HOME.lat, lng: HOME.lng, takenAt: T0 + 255 * D + 12 * H }]);
comprobar('una foto de casa en medio no parte el viaje',
  Trips.detect(conIntruso).length === 4, 'salieron ' + Trips.detect(conIntruso).length);

const mexico = trips.find((t) => t.maxKm > 1000);
comprobar('el viaje largo recoge sus ~1080 fotos',
  mexico && Math.abs(mexico.photos.length - 1080) <= 5, mexico && mexico.photos.length);
comprobar('las fotos sin GPS se asignan al viaje por su fecha',
  mexico && mexico.photos.some((p) => p.lat == null));
comprobar('propone como mucho los pines pedidos',
  mexico && Trips.suggestPins(mexico.photos, 12).length === 12);
comprobar('los pines propuestos están separados entre sí', (() => {
  const pins = Trips.suggestPins(mexico.photos, 12);
  for (let i = 0; i < pins.length; i++) {
    for (let j = i + 1; j < pins.length; j++) {
      if (Trips.haversine(pins[i].lat, pins[i].lng, pins[j].lat, pins[j].lng) < 0.05) return false;
    }
  }
  return true;
})());
comprobar('la traza se simplifica sin quedarse vacía', (() => {
  const pts = mexico.photos.filter((p) => p.lat != null).map((p) => [p.lng, p.lat]);
  const s = Trips.simplify(pts);
  return s.length > 1 && s.length <= pts.length;
})());

comprobar('sin fotos no hay viajes', Trips.detect([]).length === 0);
comprobar('sin ninguna fecha no hay viajes',
  Trips.detect(recs.map((r) => ({ ...r, takenAt: null }))).length === 0);
comprobar('sin ninguna ubicación no hay viajes',
  Trips.detect(recs.map((r) => ({ ...r, lat: null, lng: null }))).length === 0);
comprobar('un carrete que es un solo viaje da un viaje',
  Trips.detect(recs.filter((r) => r.takenAt > T0 + 119 * D && r.takenAt < T0 + 129 * D)).length === 1);


{
/* ---- Distancia recorrida y medio de transporte ----
   Los dos primeros casos salen del viaje real del usuario (Madrid-Toledo-
   Segovia) y son la trampa que hundiría a un clasificador ingenuo: 69 km
   entre dos fotos con una noche de por medio dan 4,9 km/h de media, que
   "parece" andando. */
const c = (km, h) => Trips.classifySegment(km, h, Trips.TRAVEL_DEFAULTS).mode;

comprobar('69 km a 4,9 km/h de media NO es un paseo (es motor)',
  c(68.88, 14.0) === 'motor', c(68.88, 14.0));
comprobar('122 km a 30,8 km/h es motor',
  c(121.95, 3.96) === 'motor', c(121.95, 3.96));
comprobar('1,2 km en 13 h no se puede atribuir: queda sin determinar',
  c(1.17, 13.4) === 'desconocido', c(1.17, 13.4));
comprobar('800 m en 12 min sí es a pie', c(0.8, 0.2) === 'pie', c(0.8, 0.2));
comprobar('8 km en 30 min es de rueda (bici/patinete)',
  c(8, 0.5) === 'rueda', c(8, 0.5));
comprobar('500 km en 2 h es transporte rápido',
  c(500, 2) === 'rapido', c(500, 2));

// Paseo de una tarde: 12 fotos cada 10 min avanzando ~400 m cada vez.
const paseo = [];
for (let i = 0; i < 12; i++) {
  paseo.push({ lat: 40.4168 + i * 0.0036, lng: -3.7038, takenAt: Date.UTC(2024, 3, 2, 10) + i * 600000 });
}
const tp = Trips.travelStats(paseo);
comprobar('un paseo de 12 fotos suma ~4,4 km',
  Math.abs(tp.totalKm - 4.4) < 0.3, tp.totalKm.toFixed(2));
comprobar('y se atribuye entero a "a pie"',
  tp.byMode.pie === tp.totalKm && tp.unknownShare === 0);

// Mismo paseo + un traslado en coche al final.
const mixto = paseo.concat([
  { lat: 39.8628, lng: -4.0273, takenAt: Date.UTC(2024, 3, 2, 12, 30) }
]);
const tm = Trips.travelStats(mixto);
comprobar('al añadir un traslado, la distancia a motor domina el total',
  tm.byMode.motor > tm.byMode.pie * 10, JSON.stringify(tm.byMode));
comprobar('el reparto por medios cuadra con el total',
  Math.abs(Trips.MODES.reduce((s, m) => s + tm.byMode[m], 0) - tm.totalKm) < 1e-9);
comprobar('los tramos llevan sus extremos para poder pintarlos',
  tm.segments.length === 12 && tm.segments[0].from.length === 2);

// Fotos quietas: no deben inflar la distancia con ruido de GPS.
const quietas = [];
for (let i = 0; i < 20; i++) {
  quietas.push({ lat: 40.4168 + (i % 2) * 0.00005, lng: -3.7038, takenAt: Date.UTC(2024, 3, 2, 10) + i * 60000 });
}
const tq = Trips.travelStats(quietas);
comprobar('20 fotos en el mismo sitio no suman distancia',
  tq.totalKm === 0 && tq.noiseSkipped === 19, JSON.stringify({ km: tq.totalKm, ruido: tq.noiseSkipped }));

// La línea del póster
const linea = (st) => Trips.travelLine(st);
comprobar('la línea del póster reparte el total entre los medios',
  linea(tm) === '76 km · 72 km en vehículo · 4,4 km a pie', linea(tm));
comprobar('con un solo medio no repite la cifra',
  linea(tp) === '4,4 km a pie', linea(tp));
comprobar('si todo queda sin atribuir, el póster solo lleva la distancia',
  linea({ totalKm: 3.1, byMode: { pie: 0, rueda: 0, motor: 0, rapido: 0, desconocido: 3.1 } }) === '3,1 km');
comprobar('sin distancia no hay línea', linea(null) === '' && linea(tq) === '');

const tv = Trips.travelStats([]);
comprobar('sin fotos no revienta', tv.totalKm === 0 && tv.unknownShare === 0);
}

console.log(fallos ? `\n${fallos} comprobaciones fallidas` : '\nTodo correcto');

/* --- Caso real reportado: biblioteca pequeña, sin residencia detectable,
   un tramo que dura menos que el mínimo. Antes daba "0 viajes" sin explicar
   por qué; ahora debe explicarlo, y bajar la duración mínima debe rescatarlo. */
console.log('\nCaso: 47 fotos de una tarde, sin residencia detectable');
const tardeCorta = [];
{
  const base = Date.UTC(2026, 5, 1, 14, 0); // 14:00
  for (let i = 0; i < 47; i++) {
    tardeCorta.push({
      idx: i, name: `IMG_${i}.HEIC`, kind: 'heic',
      lat: 9.94 + (rnd() - 0.5) * 0.01,
      lng: -84.09 + (rnd() - 0.5) * 0.01,
      takenAt: base + i * 45000 // 47 fotos en 34.5 minutos
    });
  }
}

const home47 = Trips.detectHome(tardeCorta);
comprobar('con solo 47 fotos no se detecta residencia (esperado)', !home47);

const conDefaults = Trips.detect(tardeCorta);
comprobar('con la duración mínima por defecto (1h) el tramo de 34 min no entra',
  conDefaults.length === 0);
comprobar('pero el diagnóstico explica por qué (no queda mudo)',
  Array.isArray(conDefaults.rejected) && conDefaults.rejected.length === 1
  && conDefaults.rejected[0].tooShort === true
  && conDefaults.rejected[0].photos === 47,
  JSON.stringify(conDefaults.rejected));

const conMinHoraCero = Trips.detect(tardeCorta, { minHours: 0 });
comprobar('bajando la duración mínima a 0, esas 47 fotos sí forman un viaje',
  conMinHoraCero.length === 1 && conMinHoraCero[0].photos.length === 47);



console.log(fallos ? `\n${fallos} comprobaciones fallidas en total` : '\nTodo correcto (incluyendo el caso reportado)');
process.exit(fallos ? 1 : 0);
