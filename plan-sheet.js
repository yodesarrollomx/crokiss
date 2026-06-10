/* =============================================================
   CroKiss — Lámina imprimible (plan-sheet.js)
   Genera la lámina profesional como SVGs en milímetros de papel.
   Lámina de DOS páginas:
     · Página 1: SOLO la planta usando toda la zona de dibujo
       (mejor escala), cotas, norte, escala gráfica y cajetín
       Aurum con 'LÁMINA 1 DE 2'.
     · Página 2: las fachadas de PlanElev.allFacades en rejilla
       2×2, TODAS a la misma escala estándar (la menor que haga
       caber la peor), etiqueta por celda, escala gráfica y el
       mismo cajetín con 'LÁMINA 2 DE 2'. Si no hay fachadas, la
       lámina vuelve a ser de UNA página.
   Vista previa en overlay (hojas apiladas) e impresión/PDF con
   window.print() — cada hoja en su propia página física.
   JS puro, sin dependencias.
   API:  PlanSheet.open(editor)   ← botón "⎙ Lámina / PDF"
         PlanSheet._buildPages(geom, opts) → [svg, ...]  (pruebas)
         PlanSheet._buildSheet(geom, opts) — alias de la página 1
   Punto de extensión fachada:    PlanSheet.setElevProvider(fn)
     (se usa PlanElev.allFacades si está; el proveedor registrado
      queda como degradación a una sola fachada)
   ============================================================= */
(function () {
  'use strict';

  var PPM = 74;                       // px por metro (mismo que el editor)
  var FORMATOS = {
    carta:    { w: 279.4, h: 215.9, nombre: 'Carta' },     // horizontal
    tabloide: { w: 431.8, h: 279.4, nombre: 'Tabloide' }
  };
  var ESCALAS = [50, 75, 100, 125, 150, 200, 250];
  var ACENTO = '#c75b39', TINTA = '#16181d', MUTED = '#6b6256', LINEA = '#d8d5cd';
  var FUENTE = 'Saira Semi Condensed, Arial, sans-serif';
  var M = 10, CAJ = 62;               // margen exterior y ancho del cajetín

  var elevProvider = null;            // lo registra plan-elev.js
  var edRef = null;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  function el(tag, attrs, inner) {
    var s = '<' + tag;
    for (var k in attrs) s += ' ' + k + '="' + attrs[k] + '"';
    return s + (inner != null ? '>' + inner + '</' + tag + '>' : '/>');
  }
  function txt(x, y, t, size, opts) {
    opts = opts || {};
    return el('text', {
      x: x, y: y, 'font-family': FUENTE, 'font-size': size,
      fill: opts.fill || TINTA, 'font-weight': opts.peso || 400,
      'text-anchor': opts.ancla || 'start', 'letter-spacing': opts.esp || 0
    }, esc(t));
  }
  var fmt1 = function (v) { return (Math.round(v * 100) / 100).toFixed(2); };

  /* ---------- render del plano (limpio, sin retícula ni manijas) ---------- */
  var isH = function (w) { return Math.abs(w.y1 - w.y2) < 1e-6; };
  function planSVG(geom, wallCm) {
    var T = (wallCm || geom.wallCm || 20) / 100, tpx = T * PPM;
    var X = function (m) { return m * PPM; }, Y = X;
    var g = '';

    geom.walls.forEach(function (w) {
      g += el('line', { x1: X(w.x1), y1: Y(w.y1), x2: X(w.x2), y2: Y(w.y2), stroke: '#2b2b2b', 'stroke-width': tpx, 'stroke-linecap': 'square' });
    });

    function vano(o, triple) {                       // ventana (3 líneas) / corrediza (2 + hojas)
      var v = '';
      if (o.wall === 'h') {
        var y = Y(o.fixed);
        v += el('rect', { x: X(o.a), y: y - tpx / 2, width: (o.b - o.a) * PPM, height: tpx, fill: '#fff' });
        (triple ? [-tpx / 2, 0, tpx / 2] : [-tpx / 2, tpx / 2]).forEach(function (off) {
          v += el('line', { x1: X(o.a), y1: y + off, x2: X(o.b), y2: y + off, stroke: '#2b2b2b', 'stroke-width': 1.3 });
        });
      } else {
        var x = X(o.fixed);
        v += el('rect', { x: x - tpx / 2, y: Y(o.a), width: tpx, height: (o.b - o.a) * PPM, fill: '#fff' });
        (triple ? [-tpx / 2, 0, tpx / 2] : [-tpx / 2, tpx / 2]).forEach(function (off) {
          v += el('line', { x1: x + off, y1: Y(o.a), x2: x + off, y2: Y(o.b), stroke: '#2b2b2b', 'stroke-width': 1.3 });
        });
      }
      return v;
    }
    geom.windows.forEach(function (o) { g += vano(o, true); });
    geom.sliders.forEach(function (o) { g += vano(o, false); });

    geom.doors.forEach(function (d) {                // abatimiento de puerta
      var hX = X(d.hx), hY = Y(d.hy);
      var aX = hX + d.along[0] * d.w * PPM, aY = hY + d.along[1] * d.w * PPM;   // cerrada (sobre el muro)
      var oX = hX + d.open[0] * d.w * PPM,  oY = hY + d.open[1] * d.w * PPM;    // abierta
      var minx = Math.min(hX, aX), miny = Math.min(hY, aY);
      g += el('rect', { x: d.wall === 'h' ? minx : hX - tpx / 2, y: d.wall === 'h' ? hY - tpx / 2 : miny,
        width: d.wall === 'h' ? Math.abs(aX - hX) : tpx, height: d.wall === 'h' ? tpx : Math.abs(aY - hY), fill: '#fff' });
      var cross = d.along[0] * d.open[1] - d.along[1] * d.open[0];
      g += el('line', { x1: hX, y1: hY, x2: oX, y2: oY, stroke: '#2b2b2b', 'stroke-width': 1.6 });
      g += el('path', { d: 'M ' + oX + ' ' + oY + ' A ' + d.w * PPM + ' ' + d.w * PPM + ' 0 0 ' + (cross > 0 ? 1 : 0) + ' ' + aX + ' ' + aY,
        fill: 'none', stroke: '#2b2b2b', 'stroke-width': 0.8, 'stroke-dasharray': '3 3', opacity: 0.8 });
    });

    var FL = window.PlanFurniture || null;           // mobiliario, reutilizando el catálogo tal cual
    var furn = '';
    (geom.furniture || []).forEach(function (f) {
      var sym = FL ? FL.draw(f.type, f.w * PPM, f.h * PPM, '#9a8f85', 1.1) : '';
      furn += el('g', { transform: 'translate(' + X(f.cx) + ' ' + Y(f.cy) + ') rotate(' + (f.rot || 0) + ')' }, sym);
    });
    g += el('g', { opacity: 0.95 }, furn);

    geom.walls.forEach(function (w) {                // longitudes de muro
      var L = Math.hypot(w.x2 - w.x1, w.y2 - w.y1); if (L < 0.3) return;
      var mx = X((w.x1 + w.x2) / 2), my = Y((w.y1 + w.y2) / 2);
      var vert = !isH(w);
      var tx = vert ? mx - 8 : mx, ty = vert ? my : my - 7;
      var attrs = { x: tx, y: ty, 'font-family': FUENTE, 'font-size': 10, fill: MUTED, 'text-anchor': 'middle' };
      if (vert) attrs.transform = 'rotate(-90 ' + tx + ' ' + ty + ')';
      g += el('text', attrs, fmt1(L));
    });
    return g;
  }

  /* ---------- cota con flechas y texto, en mm de papel ---------- */
  function cota(x1, y1, x2, y2, label, offTxt) {
    var g = el('line', { x1: x1, y1: y1, x2: x2, y2: y2, stroke: ACENTO, 'stroke-width': 0.25 });
    [[x1, y1], [x2, y2]].forEach(function (p) {
      g += el('line', { x1: p[0] - 1, y1: p[1] + 1, x2: p[0] + 1, y2: p[1] - 1, stroke: ACENTO, 'stroke-width': 0.35 });
    });
    var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    if (Math.abs(y2 - y1) < 0.01) g += txt(mx, my - 1.2 + (offTxt || 0), label, 3.2, { fill: ACENTO, ancla: 'middle', peso: 600 });
    else g += el('text', { x: mx - 1.2, y: my, 'font-family': FUENTE, 'font-size': 3.2, fill: ACENTO, 'font-weight': 600,
      'text-anchor': 'middle', transform: 'rotate(-90 ' + (mx - 1.2) + ' ' + my + ')' }, esc(label));
    return g;
  }

  /* ---------- utilidades compartidas entre páginas ---------- */
  function huella(geom) {                            // extensión del dibujo (m)
    var maxX = 0, maxY = 0;
    geom.walls.forEach(function (w) { maxX = Math.max(maxX, w.x1, w.x2); maxY = Math.max(maxY, w.y1, w.y2); });
    if (geom.lot) { maxX = Math.max(maxX, geom.lot.w); maxY = Math.max(maxY, geom.lot.d); }
    return { x: maxX || 10, y: maxY || 10 };
  }
  function marcoDoble(W, H) {
    return el('rect', { x: M, y: M, width: W - M * 2, height: H - M * 2, fill: 'none', stroke: TINTA, 'stroke-width': 0.5 }) +
           el('rect', { x: M + 2, y: M + 2, width: W - M * 2 - 4, height: H - M * 2 - 4, fill: 'none', stroke: TINTA, 'stroke-width': 0.2 });
  }
  function escalaGrafica(escala, gx, gy) {           // referencia robusta aunque impriman "ajustar a página"
    var segM = escala <= 75 ? 1 : escala <= 150 ? 2 : 5;     // metros por segmento
    var segMM = segM * (1000 / escala), g = '';
    for (var k = 0; k < 4; k++) {
      g += el('rect', { x: gx + k * segMM, y: gy, width: segMM, height: 1.6, fill: k % 2 ? '#fff' : TINTA, stroke: TINTA, 'stroke-width': 0.2 });
      g += txt(gx + k * segMM, gy + 4.4, String(k * segM), 2.6, { ancla: 'middle', fill: MUTED });
    }
    g += txt(gx + 4 * segMM, gy + 4.4, (4 * segM) + ' m', 2.6, { ancla: 'middle', fill: MUTED });
    return g;
  }
  function envolverSVG(W, H, s) {
    return el('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 ' + W + ' ' + H,
      width: W + 'mm', height: H + 'mm', style: 'background:#fff;display:block;' }, s);
  }
  /* fachadas disponibles: allFacades de PlanElev si existe; si no, el
     proveedor registrado con setElevProvider (una sola fachada) */
  function fachadasDe(geom) {
    var PE = window.PlanElev;
    if (PE && PE.allFacades) return PE.allFacades(geom) || [];
    if (elevProvider) { var f = elevProvider(geom); return f ? [f] : []; }
    return [];
  }

  /* ---------- cajetín reutilizable (columna derecha) ----------
     s = contexto de hoja { geom, W, H, F, escala, hu, totalPaginas } */
  function cajetin(s, opts, numPagina) {
    var geom = s.geom, W = s.W, H = s.H;
    var cx0 = W - M - 2 - CAJ, cy0 = M + 2, ch = H - M * 2 - 4;
    var r = el('line', { x1: cx0, y1: cy0, x2: cx0, y2: cy0 + ch, stroke: TINTA, 'stroke-width': 0.4 });
    var cx = cx0 + 4, cw = CAJ - 8, yy = cy0 + 10;

    r += txt(cx, yy, 'Cro·Kiss', 8, { peso: 700, esp: 0.6 }); yy += 4.6;
    r += txt(cx, yy, 'EL PRIMER BESO CON TU PROYECTO', 2.4, { fill: MUTED, esp: 0.7 }); yy += 7;
    r += el('line', { x1: cx, y1: yy, x2: cx + cw, y2: yy, stroke: ACENTO, 'stroke-width': 0.7 }); yy += 7;

    function campo(label, valor) {
      valor = String(valor || '—');
      if (valor.length > 26) valor = valor.slice(0, 25) + '…';   // el cajetín nunca se desborda
      r += txt(cx, yy, label.toUpperCase(), 2.5, { fill: MUTED, esp: 0.8 }); yy += 4;
      r += txt(cx, yy, valor, 4.1, { peso: 600 }); yy += 7;
    }
    campo('Proyecto', opts.planName);
    campo('Cliente', opts.cliente);
    campo('Fecha', opts.fecha);
    campo('Terreno', geom.lot ? (geom.lot.w + ' × ' + geom.lot.d + ' m') : (fmt1(s.hu.x) + ' × ' + fmt1(s.hu.y) + ' m'));
    campo('Escala', '1:' + s.escala + ' (' + s.F.nombre + ')');

    // datos del plano
    yy += 1;
    r += el('line', { x1: cx, y1: yy, x2: cx + cw, y2: yy, stroke: LINEA, 'stroke-width': 0.3 }); yy += 5.5;
    r += txt(cx, yy, 'DATOS', 2.5, { fill: MUTED, esp: 0.8 }); yy += 4.5;
    var ml = 0; geom.walls.forEach(function (w) { ml += Math.hypot(w.x2 - w.x1, w.y2 - w.y1); });
    var ev2 = geom.elev || {};
    [
      'Huella: ' + fmt1(s.hu.x) + ' × ' + fmt1(s.hu.y) + ' m  (' + fmt1(s.hu.x * s.hu.y) + ' m²)',
      'Muros: ' + geom.walls.length + '  ·  ' + fmt1(ml) + ' m lineales',
      'Vanos: ' + geom.windows.length + ' vent · ' + geom.doors.length + ' puertas · ' + geom.sliders.length + ' corr',
      'Altura de muro: ' + (ev2.hMuro || 2.4) + ' m · espesor ' + (geom.wallCm || 20) + ' cm'
    ].forEach(function (linea) { r += txt(cx, yy, linea, 3.1); yy += 4.4; });

    // leyenda de mobiliario
    var FL = window.PlanFurniture || null;
    var counts = {};
    (geom.furniture || []).forEach(function (f) { counts[f.type] = (counts[f.type] || 0) + 1; });
    var tipos = Object.keys(counts);
    if (tipos.length) {
      yy += 2;
      r += el('line', { x1: cx, y1: yy, x2: cx + cw, y2: yy, stroke: LINEA, 'stroke-width': 0.3 }); yy += 5.5;
      r += txt(cx, yy, 'MOBILIARIO', 2.5, { fill: MUTED, esp: 0.8 }); yy += 4.5;
      tipos.slice(0, 10).forEach(function (t) {
        var cat = (FL && FL.CATALOG[t]) || {};
        r += txt(cx, yy, (counts[t] > 1 ? counts[t] + ' × ' : '') + (cat.label || t), 3.1); yy += 4.2;
      });
      if (tipos.length > 10) { r += txt(cx, yy, '… y ' + (tipos.length - 10) + ' más', 3, { fill: MUTED }); yy += 4.2; }
    }

    // pie del cajetín: número de lámina + firma + disclaimer
    var by = cy0 + ch - 16;
    r += txt(cx, by - 3.2, 'LÁMINA ' + numPagina + ' DE ' + s.totalPaginas, 3.4, { peso: 700, esp: 0.8, fill: ACENTO });
    r += el('line', { x1: cx, y1: by, x2: cx + cw, y2: by, stroke: ACENTO, 'stroke-width': 0.7 });
    r += txt(cx, by + 5, 'CroKiss · Aurum Arquitectos', 3.6, { peso: 700 });
    r += txt(cx, by + 9.2, 'aurumarquitectos.com', 2.7, { fill: MUTED });
    r += txt(cx, by + 13.4, 'Anteproyecto ilustrativo — no apto para construcción', 2.3, { fill: MUTED });
    return r;
  }

  /* ---------- página 1: SOLO la planta, a la mejor escala ---------- */
  function buildPage1(geom, opts, totalPaginas) {
    opts = opts || {};
    var F = FORMATOS[opts.formato] || FORMATOS.carta;
    var W = F.w, H = F.h;
    var dz = { x: M + 4, y: M + 4, w: W - M * 2 - CAJ - 8, h: H - M * 2 - 8 };  // zona de dibujo
    var hu = huella(geom);
    if (totalPaginas == null) totalPaginas = fachadasDe(geom).length ? 2 : 1;

    // la planta usa TODA la zona de dibujo: escala = la menor estándar en la que cabe
    var planoH = dz.h, holg = 14;                    // holgura para cotas alrededor del plano
    var availW = dz.w - holg * 2, availH = planoH - holg * 2;
    var escala = 0;
    for (var i = 0; i < ESCALAS.length; i++) {
      var e = ESCALAS[i];
      if ((hu.x * 1000) / e <= availW && (hu.y * 1000) / e <= availH) { escala = e; break; }
    }
    if (!escala) {     // terreno enorme para este formato: escala exacta redondeada a 25 (nunca desbordar el marco)
      escala = Math.ceil(Math.max((hu.x * 1000) / availW, (hu.y * 1000) / availH) / 25) * 25;
    }
    var mmPerM = 1000 / escala, pxToMm = mmPerM / PPM;

    var s = marcoDoble(W, H);

    // ----- plano centrado en su zona -----
    var pw = hu.x * mmPerM, ph = hu.y * mmPerM;
    var px0 = dz.x + (dz.w - pw) / 2, py0 = dz.y + holg + (planoH - holg * 2 - ph) / 2;
    s += el('g', { transform: 'translate(' + px0 + ' ' + py0 + ') scale(' + pxToMm + ')' }, planSVG(geom, geom.wallCm));

    // cotas generales (huella)
    s += cota(px0, py0 - 5, px0 + pw, py0 - 5, fmt1(hu.x) + ' m');
    s += cota(px0 - 5, py0, px0 - 5, py0 + ph, fmt1(hu.y) + ' m');
    s += txt(px0, py0 + ph + 5.5, 'PLANTA ARQUITECTÓNICA · ESC 1:' + escala, 4, { peso: 700, esp: 0.8 });

    // norte (arriba-derecha de la zona de dibujo)
    var nx = dz.x + dz.w - 8, ny = dz.y + 10;
    s += el('circle', { cx: nx, cy: ny, r: 5.5, fill: 'none', stroke: TINTA, 'stroke-width': 0.4 });
    s += el('path', { d: 'M ' + nx + ' ' + (ny - 4.2) + ' L ' + (nx - 1.8) + ' ' + (ny + 3) + ' L ' + nx + ' ' + (ny + 1.2) + ' L ' + (nx + 1.8) + ' ' + (ny + 3) + ' Z', fill: ACENTO });
    s += txt(nx, ny - 7, 'N', 3.6, { ancla: 'middle', peso: 700 });

    // escala gráfica
    s += escalaGrafica(escala, dz.x + 2, dz.y + planoH - 4);

    // cajetín
    s += cajetin({ geom: geom, W: W, H: H, F: F, escala: escala, hu: hu, totalPaginas: totalPaginas }, opts, 1);
    return envolverSVG(W, H, s);
  }

  /* ---------- página 2: las fachadas en rejilla 2×2, MISMA escala ---------- */
  function buildPage2(geom, opts) {
    opts = opts || {};
    if (opts.conFachada === false) return null;
    var fachadas = fachadasDe(geom).slice(0, 4);
    if (!fachadas.length) return null;               // sin fachadas, la lámina queda de 1 página

    var F = FORMATOS[opts.formato] || FORMATOS.carta;
    var W = F.w, H = F.h;
    var dz = { x: M + 4, y: M + 4, w: W - M * 2 - CAJ - 8, h: H - M * 2 - 8 };
    var gap = 5, labelH = 7, holg = 5;               // separación, etiqueta y holgura por celda
    var gridH = dz.h - 9;                            // franja inferior para la escala gráfica
    var cellW = (dz.w - gap) / 2, cellH = (gridH - gap) / 2;
    var availW = cellW - holg * 2, availH = cellH - labelH - holg * 2;

    // escala estándar ÚNICA: la menor en la que cabe la PEOR fachada en su celda
    var escala = 0;
    for (var i = 0; i < ESCALAS.length; i++) {
      var e = ESCALAS[i];
      var caben = fachadas.every(function (f) {
        return f.widthM * 1000 / e <= availW && f.heightM * 1000 / e <= availH;
      });
      if (caben) { escala = e; break; }
    }
    if (!escala) {
      var peor = 0;
      fachadas.forEach(function (f) {
        peor = Math.max(peor, f.widthM * 1000 / availW, f.heightM * 1000 / availH);
      });
      escala = Math.ceil(peor / 25) * 25;
    }
    var mmPerM = 1000 / escala, fScale = mmPerM / PPM;

    var s = marcoDoble(W, H);

    // separadores sutiles de la rejilla
    s += el('line', { x1: dz.x + cellW + gap / 2, y1: dz.y, x2: dz.x + cellW + gap / 2, y2: dz.y + gridH, stroke: LINEA, 'stroke-width': 0.3 });
    if (fachadas.length > 2) {
      s += el('line', { x1: dz.x, y1: dz.y + cellH + gap / 2, x2: dz.x + dz.w, y2: dz.y + cellH + gap / 2, stroke: LINEA, 'stroke-width': 0.3 });
    }

    fachadas.forEach(function (f, i) {
      var col = i % 2, fila = (i / 2) | 0;
      var cx0 = dz.x + col * (cellW + gap), cy0 = dz.y + fila * (cellH + gap);
      var fw = f.widthM * mmPerM, fh = f.heightM * mmPerM;
      var fx = cx0 + (cellW - fw) / 2, fy = cy0 + holg + (cellH - labelH - holg * 2 - fh) / 2;
      s += el('g', { transform: 'translate(' + fx + ' ' + fy + ') scale(' + fScale + ')' }, f.svg);
      s += txt(cx0 + cellW / 2, cy0 + cellH - 2, (f.label || 'FACHADA') + ' · ESC 1:' + escala, 3.6, { peso: 700, esp: 0.8, ancla: 'middle' });
    });

    // escala gráfica (una sola vez, franja inferior)
    s += escalaGrafica(escala, dz.x + 2, dz.y + dz.h - 4);

    // el mismo cajetín, con 'LÁMINA 2 DE 2'
    s += cajetin({ geom: geom, W: W, H: H, F: F, escala: escala, hu: huella(geom), totalPaginas: 2 }, opts, 2);
    return envolverSVG(W, H, s);
  }

  /* ---------- la lámina completa: 1 o 2 páginas ---------- */
  function buildPages(geom, opts) {
    opts = opts || {};
    var p2 = buildPage2(geom, opts);
    var pages = [buildPage1(geom, opts, p2 ? 2 : 1)];
    if (p2) pages.push(p2);
    return pages;
  }

  /* ---------- overlay de vista previa + impresión ---------- */
  function ensureStyle() {
    if (document.getElementById('ck_lamina_css')) return;
    var st = document.createElement('style');
    st.id = 'ck_lamina_css';
    st.textContent =
      '#ck_lamina{position:fixed;inset:0;background:#3c3a37;z-index:200;display:flex;flex-direction:column;}' +
      '#ck_lamina .lam-bar{display:flex;gap:10px;align-items:center;padding:10px 16px;background:#16181d;color:#fbfaf8;font-family:Saira Semi Condensed,sans-serif;font-size:13.5px;flex-wrap:wrap;}' +
      '#ck_lamina .lam-bar .sp{flex:1;}' +
      '#ck_lamina .lam-bar button{font-family:inherit;font-size:13px;padding:8px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.3);background:transparent;color:#fbfaf8;cursor:pointer;}' +
      '#ck_lamina .lam-bar button.acc{background:#c75b39;border-color:#c75b39;font-weight:600;}' +
      '#ck_lamina .lam-bar button.on{background:#fbfaf8;color:#16181d;}' +
      '#ck_lamina .lam-view{flex:1;overflow:auto;padding:22px;}' +
      '#ck_lamina .lam-stack{display:flex;flex-direction:column;gap:26px;align-items:center;}' +     // hojas apiladas
      '#ck_lamina .lam-page svg{max-width:100%;height:auto;box-shadow:0 12px 40px rgba(0,0,0,.45);}' +
      '@media print{' +
        'body.ck-lamina-open>*:not(#ck_lamina){display:none!important;}' +
        'body.ck-lamina-open #ck_lamina{position:static;background:#fff;display:block;}' +
        'body.ck-lamina-open #ck_lamina .lam-bar{display:none!important;}' +
        'body.ck-lamina-open #ck_lamina .lam-view{padding:0;overflow:visible;display:block;}' +
        'body.ck-lamina-open #ck_lamina .lam-stack{display:block;}' +
        'body.ck-lamina-open #ck_lamina .lam-page{page-break-after:always;break-inside:avoid;}' +    // una hoja por página física
        'body.ck-lamina-open #ck_lamina .lam-page:last-child{page-break-after:auto;}' +
        'body.ck-lamina-open #ck_lamina .lam-page svg{box-shadow:none;max-width:none;width:100%;height:auto;}' +
      '}';
    document.head.appendChild(st);
  }

  function open(editor) {
    edRef = editor || edRef;
    if (!edRef) return;
    ensureStyle();
    var geom = edRef.getGeom();
    geom.sheet = geom.sheet || { formato: 'carta' };

    var old = document.getElementById('ck_lamina'); if (old) old.remove();
    var ov = document.createElement('div');
    ov.id = 'ck_lamina';
    document.body.appendChild(ov);
    document.body.classList.add('ck-lamina-open');

    var idnt = null;
    try { idnt = JSON.parse(localStorage.getItem('crokiss_identity_v1') || 'null'); } catch (e) {}
    var hoy = new Date();
    var opts = {
      formato: geom.sheet.formato || 'carta',
      planName: (idnt && idnt.planName) || 'Mi proyecto',
      cliente: '',
      fecha: hoy.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })
    };

    function rerender() {
      geom.sheet.formato = opts.formato;             // viaja con el proyecto (geom_json)
      if (edRef.setSheet) edRef.setSheet(geom.sheet);   // y se persiste en localStorage
      var pages = buildPages(geom, opts);
      ov.innerHTML =
        '<div class="lam-bar">' +
          '<b>⎙ Lámina</b><span style="opacity:.65">vista previa del entregable · ' +
            pages.length + (pages.length > 1 ? ' páginas' : ' página') + '</span><span class="sp"></span>' +
          '<button id="lam_carta" class="' + (opts.formato === 'carta' ? 'on' : '') + '">Carta</button>' +
          '<button id="lam_tab" class="' + (opts.formato === 'tabloide' ? 'on' : '') + '">Tabloide</button>' +
          '<button id="lam_print" class="acc">Imprimir / PDF</button>' +
          '<button id="lam_close">Cerrar</button>' +
        '</div>' +
        '<div class="lam-view"><div class="lam-stack">' +
          pages.map(function (p) { return '<div class="lam-page">' + p + '</div>'; }).join('') +
        '</div></div>';
      document.getElementById('lam_carta').addEventListener('click', function () { opts.formato = 'carta'; rerender(); });
      document.getElementById('lam_tab').addEventListener('click', function () { opts.formato = 'tabloide'; rerender(); });
      document.getElementById('lam_print').addEventListener('click', function () { window.print(); });
      document.getElementById('lam_close').addEventListener('click', close);
    }
    function close() {
      ov.remove();
      document.body.classList.remove('ck-lamina-open');
      document.removeEventListener('keydown', onEsc);
    }
    function onEsc(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onEsc);
    rerender();
  }

  window.PlanSheet = {
    open: open,
    setElevProvider: function (fn) { elevProvider = fn; },  // ← punto de extensión para plan-elev.js
    _buildSheet: buildPage1,                                // alias de compatibilidad (pruebas existentes)
    _buildPages: buildPages,                                // interno: pruebas sin DOM (1 o 2 SVGs)
    _buildPage1: buildPage1,
    _buildPage2: buildPage2
  };
})();
