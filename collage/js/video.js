/* El collage armándose, en vídeo.

   La lámina fija enseña el resultado; el vídeo enseña el viaje. La cámara va
   parada por parada en el orden del reloj de la cámara de fotos, se detiene
   mientras caen las fotos de ese sitio, salta a la siguiente, y cuando ya
   están todas se abre hasta la lámina entera.

   Las paradas no son las fotos: son los sitios. Un viaje normal tiene treinta
   fotos de una plaza y una sola en los veinte kilómetros siguientes; si la
   cámara visitara foto a foto, se pasaría medio vídeo temblando dentro de la
   misma plaza. Se agrupan las que caen en el mismo sitio y en el mismo rato, y
   cada grupo es una parada.

   Lo que hace esto posible es no volver a renderizar la lámina en cada
   fotograma: un render completo a 1080x1920 cuesta cerca de dos segundos, o
   sea medio fotograma por segundo. Render.escena() cocina una vez todo lo que
   no cambia y aquí el fotograma se queda en recortar cuatro lienzos y dibujar
   las dos o tres fotos que están entrando en ese instante.

   La grabación va a tiempo real contra el reloj de pared, no contando
   fotogramas: si uno se retrasa, se pierde ese fotograma pero el vídeo dura lo
   que tiene que durar y las fotos entran cuando les toca. Al revés —contando
   fotogramas— un tirón del navegador alargaría el vídeo y descuadraría el
   sonido que le ponga después quien lo publique. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Video = api;
}(typeof self !== 'undefined' ? self : this, function () {

  const DEFAULTS = {
    duracion: 18,      // segundos de vídeo
    fps: 30,
    entrada: 0.4,      // lo que tarda una foto en acabar de aparecer
    cierre: 2.6,       // final: abrirse al plano general y sostenerlo
    apertura: 1.3,     // de eso, lo que tarda en abrirse
    acercamiento: 2.2, // cuánto se acerca la cámara en una parada
    caja: 0.38,        // lo más que puede medir una parada, en fracción de lámina
    minParada: 0.85,   // lo menos que puede durar una parada, en segundos
    mover: 0.45,       // fracción de la parada que se gasta en llegar a ella
    moverMax: 0.6,     // y como mucho estos segundos, por larga que sea
    margen: 0.3        // aire alrededor del grupo al encuadrarlo
  };

  /* Preferencias de contenedor y códec.

     MP4/H.264 primero porque es lo único que se sube sin pelearse a Instagram
     y lo único que reproduce cualquier móvil; WebM detrás porque Firefox no da
     otra cosa. La lista se prueba en el navegador de quien exporta y no vale
     de nada mirar lo que soporte el de al lado: las compilaciones de Chromium
     sin códecs propietarios aceptan 'video/mp4' pero rechazan cualquier
     cadena avc1, y entonces el MP4 sale en AV1. */
  const MIMES = [
    'video/mp4;codecs=avc1.4d002a',
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1.640028',
    'video/mp4;codecs=h264',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];

  function mimeSoportado() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const m of MIMES) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return null;
  }

  function extensionDe(mime) { return mime && mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm'; }

  // Cupo de píxeles de la lámina: cinco lienzos de este tamaño en memoria.
  const TOPE_PX = 12e6;

  const pinza = (v, a, b) => (v < a ? a : v > b ? b : v);
  const suave = (x) => x * x * (3 - 2 * x);

  /* ---------------- las paradas ---------------- */

  /* Agrupa las fotos en sitios.

     Entra una lista ya ordenada por reloj, con la posición en la lámina y el
     instante de cada foto; sale una parada por sitio, con su caja.

     Se rompe el grupo cuando meter la foto agrandaría demasiado la caja del
     grupo, o cuando ha pasado demasiado desde la anterior: el mismo sitio en
     otro momento es otra parada, porque el vídeo cuenta un recorrido y volver
     es parte del recorrido.

     El corte es sobre la caja y no sobre la distancia al centro del grupo, que
     es lo primero que probé y no vale: el centro se desplaza con cada foto que
     entra, así que un reguero de fotos separadas de dos en dos las encadena
     todas y el grupo acaba cruzando la lámina entera. Medido sobre el viaje de
     prueba, con el centro la cámara se quedaba en 1,0x —la lámina entera— en
     siete de diecisiete paradas, o sea que no se acercaba a nada. La caja no
     puede encadenar porque es justo lo que la cámara tiene que encuadrar.

     El corte de tiempo sale de los propios datos y no de una cifra fija.
     Media hora separa bien dos visitas en una ciudad y no separa nada en un
     viaje de una semana por carretera; varias veces el salto mediano funciona
     en los dos casos, que es el mismo truco que usa el hilo del collage para
     decidir qué salto merece dibujarse. */
  function paradas(puntos, W, H, o) {
    o = o || {};
    if (!puntos || !puntos.length) return [];
    const limite = o.caja == null ? DEFAULTS.caja : o.caja;

    const saltos = [];
    for (let i = 1; i < puntos.length; i++) {
      const dt = (puntos[i].t || 0) - (puntos[i - 1].t || 0);
      if (dt > 0) saltos.push(dt);
    }
    saltos.sort((a, b) => a - b);
    const mediana = saltos.length ? saltos[Math.floor(saltos.length / 2)] : 0;
    // Sin fechas fiables no se parte por tiempo: manda solo la distancia.
    const corte = mediana > 0 ? Math.max(mediana * 6, 600000) : Infinity;

    const grupos = [];
    let g = null;
    for (let i = 0; i < puntos.length; i++) {
      const p = puntos[i];
      const hw = (p.w || 0) / 2, hh = (p.h || 0) / 2;
      const grande = g
        && ((Math.max(g.x1, p.x + hw) - Math.min(g.x0, p.x - hw)) > limite * W
          || (Math.max(g.y1, p.y + hh) - Math.min(g.y0, p.y - hh)) > limite * H);
      const tarde = g && ((p.t || 0) - g.tFin) > corte;
      if (!g || grande || tarde) {
        g = { desde: i, hasta: i, n: 0, cx: 0, cy: 0,
          x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity,
          tIni: p.t || 0, tFin: p.t || 0 };
        grupos.push(g);
      }
      g.n++;
      g.cx += (p.x - g.cx) / g.n;
      g.cy += (p.y - g.cy) / g.n;
      if (p.x - hw < g.x0) g.x0 = p.x - hw;
      if (p.x + hw > g.x1) g.x1 = p.x + hw;
      if (p.y - hh < g.y0) g.y0 = p.y - hh;
      if (p.y + hh > g.y1) g.y1 = p.y + hh;
      g.hasta = i;
      g.tFin = p.t || 0;
    }

    /* Un vídeo de quince segundos no admite cuarenta paradas: saldría un
       pase de diapositivas nervioso en el que no da tiempo a ver nada. Cuando
       sobran, se funden las dos contiguas que menos caja ocupan juntas, que
       son las que la cámara menos nota que ha dejado de visitar por separado. */
    const tope = Math.max(1, o.tope || grupos.length);
    while (grupos.length > tope) {
      let cual = 1, menor = Infinity;
      for (let i = 1; i < grupos.length; i++) {
        const a = grupos[i - 1], b = grupos[i];
        const area = (Math.max(a.x1, b.x1) - Math.min(a.x0, b.x0))
          * (Math.max(a.y1, b.y1) - Math.min(a.y0, b.y0));
        if (area < menor) { menor = area; cual = i; }
      }
      const a = grupos[cual - 1], b = grupos[cual];
      a.cx = (a.cx * a.n + b.cx * b.n) / (a.n + b.n);
      a.cy = (a.cy * a.n + b.cy * b.n) / (a.n + b.n);
      a.n += b.n;
      a.hasta = b.hasta;
      a.tFin = b.tFin;
      a.x0 = Math.min(a.x0, b.x0); a.x1 = Math.max(a.x1, b.x1);
      a.y0 = Math.min(a.y0, b.y0); a.y1 = Math.max(a.y1, b.y1);
      grupos.splice(cual, 1);
    }
    return grupos;
  }

  /* Las piezas del collage en el orden y el formato que espera paradas().

     Tiene que ordenar igual que Render.escena(), que es quien manda en el
     vídeo; aquí sirve para poder contar los sitios en el diálogo sin pagar los
     dos segundos que cuesta montar la escena entera. */
  function puntosDe(piezas) {
    return piezas.filter((p) => p.img)
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (((a.p.photo && a.p.photo.takenAt) || 0)
        - ((b.p.photo && b.p.photo.takenAt) || 0)) || (a.i - b.i))
      .map(({ p }) => ({ x: p.x, y: p.y, w: p.w, h: p.h,
        t: (p.photo && p.photo.takenAt) || 0 }));
  }

  /* Cuánto tiene que durar el vídeo para visitar de cerca todos los sitios.

     No es un capricho: si no cabe, las paradas se funden y la cámara se queda
     lejos. Con 118 fotos en 52 sitios, dieciocho segundos dan para catorce
     paradas y un acercamiento medio de 1,3x —o sea, casi la lámina entera—
     mientras que los 47 que pide visitarlos todos los deja a 2,2x. */
  function recomendado(sitios, o) {
    o = o || {};
    const min = o.minParada || DEFAULTS.minParada;
    const cierre = o.cierre == null ? DEFAULTS.cierre : o.cierre;
    return Math.ceil(sitios * min + cierre);
  }

  /* Encuadre de una caja: centro y qué fracción de la lámina se enseña.

     Se guarda como fracción y no como rectángulo porque así interpolar entre
     dos encuadres no puede romper la proporción del lienzo: ancho y alto salen
     los dos de la misma k. */
  function encuadre(caja, W, H, acercamiento, margen) {
    const m = margen == null ? DEFAULTS.margen : margen;
    const bw = (caja.x1 - caja.x0) * (1 + m);
    const bh = (caja.y1 - caja.y0) * (1 + m);
    const k = pinza(Math.max(bw / W, bh / H), 1 / Math.max(1, acercamiento), 1);
    return { cx: (caja.x0 + caja.x1) / 2, cy: (caja.y0 + caja.y1) / 2, k };
  }

  function mezclar(a, b, f) {
    return { cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f,
      k: a.k + (b.k - a.k) * f };
  }

  /* Del encuadre al recorte, pegado a los bordes de la lámina: si se saliera,
     drawImage rellenaría con transparencia y el vídeo enseñaría una banda
     vacía en un lado. */
  function recuadro(c, W, H) {
    const sw = W * c.k, sh = H * c.k;
    return { sx: pinza(c.cx - sw / 2, 0, W - sw), sy: pinza(c.cy - sh / 2, 0, H - sh), sw, sh };
  }

  /* ---------------- la línea de tiempo ---------------- */

  /* Reparto de tiempos entre paradas.

     El tiempo de cada parada no es proporcional a sus fotos: va con la raíz.
     Proporcional, una parada de una sola foto se quedaría en dos fotogramas
     mientras la plaza con treinta se lleva medio vídeo. Con la raíz, treinta
     fotos duran unas seis veces lo que una, no treinta, y siguen entrando de
     una en una porque dentro de la parada se reparten en su hueco.

     La última foto de cada parada acaba de entrar justo al terminarla, no
     empieza entonces: si no, la cámara se iría con la foto a medio aparecer. */
  function plan(grupos, o) {
    o = o || {};
    const n = grupos.reduce((a, g) => a + g.n, 0);
    const duracion = Math.max(2, o.duracion || DEFAULTS.duracion);
    const cierre = pinza(o.cierre == null ? DEFAULTS.cierre : o.cierre, 0.4, duracion * 0.45);
    const montaje = duracion - cierre;
    const apertura = pinza(o.apertura == null ? DEFAULTS.apertura : o.apertura, 0.2, cierre);

    const peso = (g) => 1 + Math.sqrt(Math.max(0, g.n - 1));
    const suma = grupos.reduce((a, g) => a + peso(g), 0) || 1;
    let menor = montaje;
    for (const g of grupos) menor = Math.min(menor, montaje * peso(g) / suma);
    // Una foto no puede tardar en aparecer más que la parada en la que aparece.
    const entrada = pinza(o.entrada == null ? DEFAULTS.entrada : o.entrada,
      0.05, Math.max(0.08, menor * 0.6));

    const inicio = new Array(n);
    const lista = [];
    let t = 0;
    for (const g of grupos) {
      const dur = montaje * peso(g) / suma;
      const hueco = Math.max(0, dur - entrada);
      for (let k = 0; k < g.n; k++) {
        inicio[g.desde + k] = t + (g.n <= 1 ? 0 : (k / (g.n - 1)) * hueco);
      }
      lista.push({ ini: t, fin: t + dur, n: g.n, desde: g.desde, hasta: g.hasta, caja: g });
      t += dur;
    }
    return { n, duracion, cierre, montaje, apertura, entrada, inicio, paradas: lista };
  }

  /* Qué se ve en el instante t.

     `firmes` es un contador y no una lista porque los tiempos de entrada van
     en orden: si la foto i ya está puesta, todas las anteriores también. Eso
     permite acumular las fotos asentadas en un lienzo aparte y dibujar solo
     las que están entrando. */
  function estado(pl, t) {
    /* El montaje termina, por construcción, cuando la última foto acaba de
       entrar. Decirlo aquí en vez de dejarlo salir de la aritmética no es un
       apaño: los repartos dan cifras como 12,950000000000001 y la última se
       quedaba a un cuatrillonésimo de asentarse, con lo que el plano general
       arrancaba enseñando una foto a medio aparecer. */
    if (t >= pl.montaje) {
      return { firmes: pl.n, vuelo: [], traza: 1, fin: t >= pl.duracion };
    }
    let firmes = 0;
    const vuelo = [];
    for (let i = 0; i < pl.n; i++) {
      const d = t - pl.inicio[i];
      if (d >= pl.entrada) firmes = i + 1;
      else if (d > 0) vuelo.push({ i, alpha: d / pl.entrada });
    }
    return {
      firmes,
      vuelo,
      traza: pl.montaje > 0 ? pinza(t / pl.montaje, 0, 1) : 1,
      fin: t >= pl.duracion
    };
  }

  /* Cuánto se ha impreso ya el mobiliario de la lámina: 0 durante el
     recorrido, 1 con el plano general asentado. */
  function remate(pl, t) {
    if (t < pl.montaje) return 0;
    if (!(pl.apertura > 0)) return 1;
    return suave(pinza((t - pl.montaje) / pl.apertura, 0, 1));
  }

  /* Dónde mira la cámara en el instante t.

     Dentro de una parada: llega en el primer tramo y se queda quieta el resto,
     que es lo que la hace legible. Moviéndose todo el rato el vídeo parece
     grabado a pulso y no se llega a mirar ninguna foto.

     Los desplazamientos van con smoothstep: arranca y frena suave. Con un
     easeOut la cámara salía disparada y se posaba, que para un salto entre dos
     sitios se lee como un tirón. */
  function camara(pl, t, W, H, acercamiento, o) {
    o = o || {};
    const frac = o.mover == null ? DEFAULTS.mover : o.mover;
    const tope = o.moverMax == null ? DEFAULTS.moverMax : o.moverMax;
    const lleno = { cx: W / 2, cy: H / 2, k: 1 };
    const ps = pl.paradas;
    if (!ps || !ps.length) return recuadro(lleno, W, H);
    const enc = (i) => encuadre(ps[i].caja, W, H, acercamiento, o.margen);

    // Terminado el montaje, el plano general: la lámina entera.
    if (t >= pl.montaje) {
      const f = pl.apertura > 0 ? pinza((t - pl.montaje) / pl.apertura, 0, 1) : 1;
      return recuadro(mezclar(enc(ps.length - 1), lleno, suave(f)), W, H);
    }

    let i = 0;
    while (i < ps.length - 1 && t >= ps[i].fin) i++;
    const p = ps[i];
    const dur = (p.fin - p.ini) || 1;
    /* El desplazamiento es una fracción de la parada pero con un tope en
       segundos: en una parada larga, gastar el 45% en llegar deja la cámara
       arrastrándose durante segundo y medio y parece que se ha atascado. */
    const viaje = Math.min(frac, tope / dur);
    const u = pinza((t - p.ini) / dur, 0, 1);
    if (i === 0 || u >= viaje) return recuadro(enc(i), W, H);
    return recuadro(mezclar(enc(i - 1), enc(i), suave(u / viaje)), W, H);
  }

  /* ---------------- lo que necesita navegador ---------------- */

  function lienzo(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* Prepara todo lo caro y devuelve una función que pinta el instante t.
     Separado de la grabación para poder mirar fotogramas sueltos en las
     pruebas sin arrancar un MediaRecorder. */
  function pelicula(o) {
    const ancho = o.ancho, alto = o.alto;
    let acerca = pinza(o.acercamiento == null ? DEFAULTS.acercamiento : o.acercamiento, 1, 3);
    /* Acercarse cuesta memoria, y en cuadrado: la lámina se guarda en cinco
       lienzos y cada uno crece con el acercamiento al cuadrado. A 1280x1920 y
       3x serían cuatrocientos megas, que en un móvil no hay. Cuando se pasa
       del cupo se recorta el acercamiento en vez de dejar que el navegador se
       quede sin memoria a mitad de grabación. */
    if (ancho * alto * acerca * acerca > TOPE_PX) {
      acerca = Math.max(1, Math.sqrt(TOPE_PX / (ancho * alto)));
    }
    /* La lámina se dibuja al tamaño del encuadre más cerrado. Así la parada
       más próxima sale a píxel y ningún encuadre amplía nunca el original:
       todos los demás son reducciones, que no se notan. */
    const W = Math.round(ancho * acerca), H = Math.round(alto * acerca);
    const esc = window.Render.escena(W, H, o.model, o.s);
    if (!esc.piezas.length) throw new Error('El collage no tiene ninguna foto que enseñar.');

    const duracion = Math.max(2, o.duracion || DEFAULTS.duracion);
    const cierre = pinza(o.cierre == null ? DEFAULTS.cierre : o.cierre, 0.4, duracion * 0.45);
    const grupos = paradas(esc.piezas.map((p) => ({
      x: p.x, y: p.y, w: p.w, h: p.h, t: (p.photo && p.photo.takenAt) || 0
    })), W, H, {
      caja: o.caja,
      tope: Math.max(1, Math.floor((duracion - cierre) / (o.minParada || DEFAULTS.minParada)))
    });
    const pl = plan(grupos, o);

    /* El hilo y la numeración están escritos en el orden del montaje, no en el
       del reloj, así que hace falta traducir. Una pieza sin imagen no espera a
       ninguna foto: se da por puesta desde el principio, y así el último
       fotograma coincide con la lámina fija. */
    const posDe = new Map();
    esc.piezas.forEach((p, i) => posDe.set(p.ruta, i));
    const visible = (st) => (ruta) => {
      const i = posDe.get(ruta);
      return i == null ? true : i < st.firmes;
    };

    const poso = lienzo(W, H).getContext('2d');
    const capa = lienzo(W, H).getContext('2d');
    const salida = lienzo(ancho, alto);
    const v = salida.getContext('2d');
    // El grano va a resolución de vídeo, no de lámina: así no se amplía con el
    // encuadre y se mantiene del mismo tamaño en pantalla todo el rato.
    const grano = window.Paper.granoCapas(ancho, alto, esc.granoNivel, 20260918);
    let puestas = 0;

    return {
      plan: pl,
      lienzo: salida,
      fotos: esc.piezas.length,
      paradas: pl.paradas.length,
      acercamiento: acerca,
      lamina: { W, H },

      en(t) {
        const st = estado(pl, t);
        while (puestas < st.firmes) { esc.pieza(poso, puestas, 1, 1); puestas++; }

        /* Las fotos van en una capa aparte y no sueltas sobre el papel: así el
           borde difuminado de cada una se funde con la vecina y no con el
           fondo, que es lo que hace que el collage pinte el mapa en vez de
           quedar en manchas sueltas. La lámina fija hace lo mismo.

           Cuando no hay ninguna foto entrando, esa capa ya es el poso y se usa
           tal cual.

           El último fotograma no sale exactamente igual que la lámina
           descargada, y no es un fallo: la lámina apila las fotos en el orden
           del montaje —agrupadas por parada— y el vídeo en el del reloj, que
           es de lo que va. Cuando dos paradas se entrelazan en el tiempo, las
           que se solapan quedan una encima de otra al revés. */
        const hayVuelo = st.vuelo.length > 0;
        if (hayVuelo) {
          capa.clearRect(0, 0, W, H);
          capa.drawImage(poso.canvas, 0, 0);
          for (const f of st.vuelo) {
            const a = suave(f.alpha);
            esc.pieza(capa, f.i, a, 1.06 - 0.06 * a);
          }
        }
        const fotos = (hayVuelo ? capa : poso).canvas;

        const c = camara(pl, t, W, H, acerca, o);
        const k = ancho / c.sw;
        const ver = visible(st);
        /* Los trazos se dibujan con la transformada del encuadre en vez de
           pintarse en la lámina y recortarse después: así engordan al
           acercarse, como engordaría el trazo de una lámina de papel al
           acercarle la cámara. */
        const conCamara = (fn) => {
          v.save();
          v.setTransform(k, 0, 0, k, -c.sx * k, -c.sy * k);
          fn();
          v.restore();
        };

        v.setTransform(1, 0, 0, 1, 0, 0);
        v.globalCompositeOperation = 'source-over';
        v.globalAlpha = 1;
        v.filter = 'none';
        v.clearRect(0, 0, ancho, alto);
        v.drawImage(esc.fondo, c.sx, c.sy, c.sw, c.sh, 0, 0, ancho, alto);

        conCamara(() => { esc.traza(v, st.traza); esc.hilo(v, ver, false); });

        v.save();
        v.globalCompositeOperation = esc.mezcla;
        if (esc.filtro) v.filter = esc.filtro;
        v.drawImage(fotos, c.sx, c.sy, c.sw, c.sh, 0, 0, ancho, alto);
        v.restore();

        conCamara(() => { esc.hilo(v, ver, true); esc.numeros(v, ver); });

        v.drawImage(esc.encima, c.sx, c.sy, c.sw, c.sh, 0, 0, ancho, alto);
        const imp = remate(pl, t);
        if (imp > 0) {
          v.save();
          v.globalAlpha = imp;
          v.drawImage(esc.remate, c.sx, c.sy, c.sw, c.sh, 0, 0, ancho, alto);
          v.restore();
        }
        window.Paper.granoPegar(v, ancho, alto, grano);
        return salida;
      }
    };
  }

  /* Graba la película y devuelve el fichero. */
  async function grabar(peli, o) {
    const fps = Math.max(10, Math.min(60, o.fps || DEFAULTS.fps));
    const mime = mimeSoportado();
    if (typeof MediaRecorder === 'undefined' || !peli.lienzo.captureStream) {
      throw new Error('Este navegador no sabe grabar vídeo desde un lienzo.');
    }
    const stream = peli.lienzo.captureStream(fps);
    const rec = new MediaRecorder(stream, Object.assign(
      { videoBitsPerSecond: o.bitrate || 12e6 }, mime ? { mimeType: mime } : {}));
    const trozos = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) trozos.push(e.data); };
    const cerrado = new Promise((res) => { rec.onstop = res; });

    // Primer fotograma antes de arrancar: si no, el vídeo abre en negro.
    peli.en(0);
    rec.start();

    const reloj = () => (performance.now ? performance.now() : Date.now());
    const t0 = reloj();
    const paso1 = 1 / fps;
    const total = Math.max(1, Math.round(peli.plan.duracion * fps));
    let pintados = 0, ultimo = -1;

    /* El navegador llama a requestAnimationFrame a la frecuencia de la
       pantalla, que suele ser 60 Hz: pintar en todas las llamadas sería
       trabajo tirado si el vídeo va a 30. Se pinta cuando toca una casilla
       nueva de la rejilla de tiempos, y las casillas que se salten por ir
       lento son fotogramas perdidos de verdad, que es lo que hay que contar. */
    await new Promise((res) => {
      const paso = () => {
        const t = (reloj() - t0) / 1000;
        const casilla = Math.min(total, Math.floor(t / paso1));
        if (casilla > ultimo) {
          ultimo = casilla;
          const corte = Math.min(casilla * paso1, peli.plan.duracion);
          peli.en(corte);
          pintados++;
          if (o.vista) o.vista(peli.lienzo, corte);
          if (o.progreso) o.progreso(corte / peli.plan.duracion);
        }
        if (o.cancelado && o.cancelado()) return res();
        if (t >= peli.plan.duracion) return res();
        requestAnimationFrame(paso);
      };
      requestAnimationFrame(paso);
    });

    rec.stop();
    stream.getTracks().forEach((tr) => tr.stop());
    await cerrado;
    return {
      blob: new Blob(trozos, { type: mime || 'video/webm' }),
      mime: mime || 'video/webm',
      extension: extensionDe(mime),
      pasadas: pintados,
      perdidos: Math.max(0, total - pintados)
    };
  }

  return {
    DEFAULTS, MIMES, paradas, puntosDe, recomendado, encuadre, recuadro,
    plan, estado, camara, remate,
    mimeSoportado, extensionDe, pelicula, grabar, suave
  };
}));
