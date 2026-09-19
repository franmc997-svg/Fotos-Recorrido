/* El collage armándose, en vídeo.

   La lámina fija enseña el resultado; el vídeo enseña el viaje. Las fotos
   entran por orden de reloj de la cámara, la traza se va dibujando con ellas y
   el encuadre arranca cerrado sobre la primera foto y se abre hasta que cabe
   todo el recorrido.

   Lo que hace esto posible es no volver a renderizar la lámina en cada
   fotograma: un render completo a 1080x1920 cuesta cerca de dos segundos, o
   sea medio fotograma por segundo. Render.escena() cocina una vez todo lo que
   no cambia y aquí el fotograma se queda en pegar cuatro lienzos y dibujar las
   dos o tres fotos que están entrando en ese instante. El resto —papel, mapa,
   manchas, marco, textos, grano— ya está hecho.

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
    duracion: 15,   // segundos de vídeo
    fps: 30,
    entrada: 0.45,  // lo que tarda una foto en acabar de aparecer
    cierre: 1.6,    // lámina completa sostenida al final
    zoom: 1.25      // cuánto se cierra el encuadre al empezar (1 = nada)
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

  const pinza = (v, a, b) => (v < a ? a : v > b ? b : v);
  const suave = (x) => x * x * (3 - 2 * x);

  /* Reparto de tiempos.

     La última foto tiene que acabar de entrar justo cuando termina el montaje,
     no empezar entonces: si no, el cierre se come su entrada y la lámina
     aparece completa de golpe en el último instante. */
  function plan(n, o) {
    o = o || {};
    const duracion = Math.max(2, o.duracion || DEFAULTS.duracion);
    const cierre = pinza(o.cierre == null ? DEFAULTS.cierre : o.cierre, 0, duracion * 0.4);
    const montaje = duracion - cierre;
    const entrada = pinza(o.entrada == null ? DEFAULTS.entrada : o.entrada, 0.05, montaje * 0.5);
    const ultimo = Math.max(0, montaje - entrada);
    const inicio = [];
    for (let i = 0; i < n; i++) inicio.push(n <= 1 ? 0 : (i / (n - 1)) * ultimo);
    return { n, duracion, cierre, montaje, entrada, inicio };
  }

  /* Qué se ve en el instante t.

     `firmes` es un contador y no una lista porque los tiempos de entrada van
     en orden: si la foto i ya está puesta, todas las anteriores también. Eso
     permite acumular las fotos asentadas en un lienzo aparte y dibujar solo
     las que están entrando. */
  function estado(pl, t) {
    /* El montaje termina, por construcción, cuando la última foto acaba de
       entrar. Decirlo aquí en vez de dejarlo salir de la aritmética no es un
       apaño: con duración 15 y cierre 1,6 el reparto da 12,950000000000001 y
       la última se quedaba a un cuatrillonésimo de asentarse, con lo que el
       cierre arrancaba enseñando una foto a medio aparecer. */
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

  /* Recorte del encuadre sobre la lámina, en coordenadas de la lámina.

     La apertura va con smoothstep y no con un easeOut: con easeOut la mayor
     parte del recorrido se gasta en el primer tercio y a mitad de vídeo el
     encuadre ya estaba abierto del todo, con lo que la segunda mitad se queda
     quieta mientras siguen entrando fotos. Smoothstep arranca despacio —da
     tiempo a ver de cerca las primeras—, abre en el tramo central y se posa
     al final en vez de frenar en seco. */
  function camara(pl, t, W, H, zoom, foco) {
    const z0 = Math.max(1, zoom || 1);
    const f = pl.montaje > 0 ? pinza(t / pl.montaje, 0, 1) : 1;
    const e = suave(f);
    const z = z0 + (1 - z0) * e;
    const sw = W / z, sh = H / z;
    const fx = foco && foco.length ? foco[0] : W / 2;
    const fy = foco && foco.length ? foco[1] : H / 2;
    return {
      sx: pinza(fx + (W / 2 - fx) * e - sw / 2, 0, W - sw),
      sy: pinza(fy + (H / 2 - fy) * e - sh / 2, 0, H - sh),
      sw,
      sh
    };
  }

  /* ---------------- lo que necesita navegador ---------------- */

  function lienzo(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* Un fotograma completo, en coordenadas de la lámina.

     El orden es el mismo que el de la lámina fija: fondo revelado, traza e
     hilo de debajo, la capa de fotos entera (con su mezcla y su saturación,
     que van sobre la capa y no sobre cada foto), los adornos de encima, el
     grano y por último la suciedad, que en la lámina va después del revelado.

     Las fotos asentadas viven en `poso` y solo se añaden una vez; las que
     están entrando se pintan encima en cada pasada. Por eso el coste total de
     dibujar fotos en todo el vídeo es el de dibujarlas una vez, no el de
     dibujarlas en cada fotograma. */
  function pintar(esc, pl, t, buf, visible) {
    const st = estado(pl, t);
    const { W, H } = esc;

    while (buf.puestas < st.firmes) { esc.pieza(buf.poso, buf.puestas, 1, 1); buf.puestas++; }

    /* Las fotos van en una capa aparte y no sueltas sobre el papel: así el
       borde difuminado de cada una se funde con la vecina y no con el fondo,
       que es lo que hace que el collage pinte el mapa en vez de quedar en
       manchas sueltas. La lámina fija hace lo mismo.

       Cuando no hay ninguna foto entrando, esa capa ya es el poso: se pega tal
       cual y nos ahorramos la copia.

       El último fotograma no sale exactamente igual que la lámina descargada,
       y no es un fallo: la lámina apila las fotos en el orden del montaje
       —agrupadas por parada— y el vídeo las apila en el orden del reloj, que
       es de lo que va. Cuando dos paradas se entrelazan en el tiempo, las que
       se solapan quedan una encima de otra al revés. Medido sobre el viaje de
       prueba: difieren un 8% de los píxeles, casi todos en un solo nivel. */
    const hayVuelo = st.vuelo.length > 0;
    if (hayVuelo) {
      const cp = buf.capa;
      cp.clearRect(0, 0, W, H);
      cp.drawImage(buf.poso.canvas, 0, 0);
      for (const v of st.vuelo) {
        const a = suave(v.alpha);
        esc.pieza(cp, v.i, a, 1.06 - 0.06 * a);
      }
    }
    const fotos = (hayVuelo ? buf.capa : buf.poso).canvas;

    const p = buf.lamina;
    p.save();
    p.setTransform(1, 0, 0, 1, 0, 0);
    p.globalCompositeOperation = 'source-over';
    p.globalAlpha = 1;
    p.filter = 'none';
    p.clearRect(0, 0, W, H);
    p.drawImage(esc.fondo, 0, 0);
    esc.traza(p, st.traza);
    esc.hilo(p, visible(st), false);

    p.save();
    p.globalCompositeOperation = esc.mezcla;
    if (esc.filtro) p.filter = esc.filtro;
    p.drawImage(fotos, 0, 0);
    p.restore();

    esc.hilo(p, visible(st), true);
    esc.numeros(p, visible(st));
    p.drawImage(esc.frente, 0, 0);
    window.Paper.granoPegar(p, W, H, esc.grano);
    p.drawImage(esc.acabado, 0, 0);
    p.restore();
    return st;
  }

  /* Prepara todo lo caro y devuelve una función que pinta el instante t sobre
     el lienzo del vídeo. Separado de la grabación para poder mirar fotogramas
     sueltos en las pruebas sin arrancar un MediaRecorder. */
  function pelicula(o) {
    const ancho = o.ancho, alto = o.alto;
    const zoom = Math.max(1, o.zoom == null ? DEFAULTS.zoom : o.zoom);
    // La lámina se dibuja al tamaño del encuadre más cerrado: así el momento
    // de máximo acercamiento sale a píxel y no ampliado.
    const W = Math.round(ancho * zoom), H = Math.round(alto * zoom);
    const esc = window.Render.escena(W, H, o.model, o.s);
    if (!esc.piezas.length) throw new Error('El collage no tiene ninguna foto que enseñar.');

    const pl = plan(esc.piezas.length, o);
    const foco = [esc.piezas[0].x, esc.piezas[0].y];

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

    const buf = {
      poso: lienzo(W, H).getContext('2d'),
      capa: lienzo(W, H).getContext('2d'),
      lamina: lienzo(W, H).getContext('2d'),
      puestas: 0
    };
    const salida = lienzo(ancho, alto);
    const sctx = salida.getContext('2d');

    return {
      plan: pl,
      lienzo: salida,
      fotos: esc.piezas.length,
      en(t) {
        pintar(esc, pl, t, buf, visible);
        const c = camara(pl, t, W, H, zoom, foco);
        sctx.clearRect(0, 0, ancho, alto);
        sctx.drawImage(buf.lamina.canvas, c.sx, c.sy, c.sw, c.sh, 0, 0, ancho, alto);
        return salida;
      }
    };
  }

  /* Graba la película y devuelve el fichero.

     El reloj es `performance.now()` y no el número de pasadas: un tirón del
     navegador cuesta un fotograma, no medio segundo de vídeo. */
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

    const pasadas = pintados;
    const perdidos = Math.max(0, total - pintados);
    rec.stop();
    stream.getTracks().forEach((tr) => tr.stop());
    await cerrado;
    return {
      blob: new Blob(trozos, { type: mime || 'video/webm' }),
      mime: mime || 'video/webm',
      extension: extensionDe(mime),
      pasadas,
      perdidos
    };
  }

  return {
    DEFAULTS, MIMES, plan, estado, camara, mimeSoportado, extensionDe,
    pelicula, grabar, suave
  };
}));
