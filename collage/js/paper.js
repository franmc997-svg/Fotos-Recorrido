/* Tratamiento de escaneo.

   Lo que separa "fotos pegadas en un lienzo" de "el escaneo de un cuaderno de
   viaje" no es el collage: es lo que pasa después. Papel con grano, tinta que
   no llega igual a todas partes, contraste de fotocopia y un poco de suciedad.
   Todo esto se aplica al lienzo entero al final, textos incluidos, porque un
   escaneo no distingue entre la foto y lo escrito al lado. */
(function () {

  // xorshift: hace falta ruido rápido y repetible, no criptografía.
  function rnd(seed) {
    let s = (seed >>> 0) || 2463534242;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function hex(c) {
    const h = c.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /* Manchas de papel: ruido de baja frecuencia estirado. Hacerlo píxel a píxel
     a resolución de póster costaría más que todo lo demás junto; un lienzo
     diminuto escalado da el mismo resultado por una fracción del tiempo. */
  function mottle(W, H, seed, cells) {
    const n = Math.max(2, cells | 0);
    const c = document.createElement('canvas');
    c.width = n; c.height = Math.max(2, Math.round(n * H / W));
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(c.width, c.height);
    const r = rnd(seed);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 200 + Math.floor(r() * 55);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /* Fondo de papel: color plano, manchas y unas fibras. Va antes que nada. */
  function base(ctx, W, H, o) {
    ctx.save();
    ctx.fillStyle = o.paper;
    ctx.fillRect(0, 0, W, H);
    if (o.texture > 0) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = 0.22 * o.texture;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(mottle(W, H, 99, 26), 0, 0, W, H);
      ctx.globalAlpha = 0.12 * o.texture;
      ctx.drawImage(mottle(W, H, 4711, 120), 0, 0, W, H);

      // Fibras: rayas finas y largas, como el papel de acuarela al trasluz.
      ctx.globalAlpha = 0.05 * o.texture;
      ctx.strokeStyle = o.ink;
      ctx.lineWidth = Math.max(1, W / 2400);
      const r = rnd(20260918);
      for (let i = 0; i < 160; i++) {
        const y = r() * H;
        const x = r() * W;
        const len = (0.04 + r() * 0.16) * W;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + len, y + (r() - 0.5) * H * 0.01);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* Revelado: duotono, contraste y grano en una sola pasada de píxeles. Es lo
     único que se hace píxel a píxel; el resto son operaciones de canvas. */
  function develop(ctx, W, H, o) {
    if (o.duotone <= 0 && o.grain <= 0 && o.contrast === 1) return;
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const [pr, pg, pb] = hex(o.paper);
    const [ir, ig, ib] = hex(o.ink);
    const k = o.duotone;
    const c = o.contrast;
    const b = o.brightness || 0;
    const g = o.grain * 255;
    const r = rnd(o.seed || 1234567);

    for (let i = 0; i < d.length; i += 4) {
      const R = d[i], G = d[i + 1], B = d[i + 2];
      let lum = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
      lum = (lum - 0.5) * c + 0.5 + b;
      if (lum < 0) lum = 0; else if (lum > 1) lum = 1;

      // Duotono: las sombras toman el color de la tinta y las luces el del papel.
      const dr = ir + (pr - ir) * lum;
      const dg = ig + (pg - ig) * lum;
      const db = ib + (pb - ib) * lum;

      let nr = R + (dr - R) * k;
      let ng = G + (dg - G) * k;
      let nb = B + (db - B) * k;

      if (g > 0) {
        const n = (r() - 0.5) * g;
        nr += n; ng += n; nb += n;
      }
      d[i] = nr < 0 ? 0 : nr > 255 ? 255 : nr;
      d[i + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng;
      d[i + 2] = nb < 0 ? 0 : nb > 255 ? 255 : nb;
    }
    ctx.putImageData(img, 0, 0);
  }

  /* Suciedad de escáner: viñeta, exposición desigual, motas y una sombra en un
     borde, como cuando la tapa no cierra del todo. */
  function grime(ctx, W, H, o) {
    if (o.grime <= 0) return;
    const a = o.grime;
    ctx.save();

    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${0.3 * a})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const lin = ctx.createLinearGradient(0, 0, W * 0.9, H);
    lin.addColorStop(0, `rgba(0,0,0,${0.09 * a})`);
    lin.addColorStop(0.45, 'rgba(0,0,0,0)');
    lin.addColorStop(1, `rgba(0,0,0,${0.05 * a})`);
    ctx.fillStyle = lin;
    ctx.fillRect(0, 0, W, H);

    const r = rnd(8675309);
    ctx.fillStyle = `rgba(0,0,0,${0.5 * a})`;
    const specks = Math.round(140 * a);
    for (let i = 0; i < specks; i++) {
      const x = r() * W, y = r() * H;
      const s = (0.0004 + r() * 0.0016) * W;
      ctx.beginPath();
      ctx.ellipse(x, y, s, s * (0.5 + r()), r() * 3.14, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }

  function rgba(color, a) {
    const [r, g, b] = hex(color);
    return `rgba(${r},${g},${b},${a})`;
  }

  window.Paper = { base, develop, grime, mottle, rnd, hex, rgba };
})();
