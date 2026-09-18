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
