/* =============================================================
   CroKiss — Fachadas automáticas (plan-elev.js)
   Alzados 2D de las 4 orientaciones proyectando los muros de la
   planta, con saneamiento de modelo (estilo validador BIM):
     · muros casi-colineales/duplicados se FUSIONAN por tolerancia
       de profundidad (DTOL) — sin costuras ni contornos dobles
     · cada alzado se RECORTA al dominio de los muros
       perpendiculares y al terreno — un muro que "se pasa" del
       perímetro no genera masas flotantes (y queda como aviso)
     · vanos parcialmente fuera se RECORTAN o se omiten (aviso)
   Dibujo con jerarquía de plumas (contorno > cantos > vanos >
   niveles), silueta perimetral única, pretil en todos los planos,
   sombra de canto en retranqueos, cristal con gradiente, marcos y
   repisones en ventanas, puertas con tablero y umbral, terreno
   con hachurado, niveles raya-punto FUERA del volumen y cota
   vertical de alturas. Overrides por vano señalizados.
   Espejado (el observador mira HACIA la casa):
     S: s = x · N: s = maxX − x · E: s = maxY − y · O: s = y
   API:
     PlanElev.facade(geom, dir, opts?)  dir ∈ 'S'|'N'|'E'|'O'
       opts = { textos: true,            ← false: sin etiquetas (lámina)
                resaltar: {kind,id} }    ← halo + cotas vivas del vano
       → { svg, widthM, heightM, label, dir, stats, avisos } | null
       stats = { muroM2, vanoM2, pctHuecos, nVanos }
     PlanElev.allFacades(geom, opts?) → [fachadas no nulas]
     PlanElev.frontFacade(geom) — alias de facade(geom,'S')
   Limitaciones: muros oblicuos se omiten; sin cubierta inclinada.
   ============================================================= */
(function () {
  'use strict';

  var PPM = 74;                                   // px por metro (mismo del plano)
  var DEF = { hMuro: 2.40, antepecho: 0.90, dintel: 2.10, cubierta: 'losa', pretil: 0.35 };
  var EPS = 1e-6;
  var DTOL = 0.20;                                // tolerancia de fusión de planos (m)
  var SLIVER = 0.12;                              // tramos menores se descartan (m)
  var LABELS = { S: 'FACHADA SUR', N: 'FACHADA NORTE', E: 'FACHADA ORIENTE', O: 'FACHADA PONIENTE' };

  // paleta y tabla de plumas (px de plano; equivalen a 0.50/0.35/0.25/0.13 mm)
  var TINTA = '#2b2b2b', MUTED = '#6b6256', NIVEL = '#8d8579', ACENTO = '#c75b39';
  var MURO_F = '#f4f2ee', MURO_R = '#e6e1d8';     // frente / retranqueo (más oscuro = más lejos)
  var PLUMA = { contorno: 3.0, canto: 1.8, vano: 1.5, detalle: 0.8 };
  var FUENTE = 'Saira Semi Condensed, Arial, sans-serif';

  function el(tag, attrs, inner) {
    var s = '<' + tag;
    for (var k in attrs) s += ' ' + k + '="' + attrs[k] + '"';
    return s + (inner != null ? '>' + inner + '</' + tag + '>' : '/>');
  }
  function txt(x, y, t, size, attrs) {
    return el('text', Object.assign({ x: x, y: y, 'font-family': FUENTE, 'font-size': size,
      fill: NIVEL, 'paint-order': 'stroke', stroke: '#ffffff', 'stroke-width': 3 }, attrs || {}), t);
  }
  var isH = function (w) { return Math.abs(w.y1 - w.y2) < EPS; };
  var isV = function (w) { return Math.abs(w.x1 - w.x2) < EPS; };
  var num = function (v, d) { return typeof v === 'number' ? v : d; };   // 0 es válido (antepecho 0 ya no se ignora)

  /* barrido 1D con regla de ENVOLVENTE: en cada subintervalo gana el tramo
     más cercano al observador, pero un muro interior ('int') que esté DETRÁS
     del muro exterior ('ext') más cercano de ese tramo NUNCA participa —
     una fachada muestra el exterior de la casa, no un corte por dentro. */
  function sweep(tramos) {
    var cortes = [];
    tramos.forEach(function (t) { cortes.push(t.a, t.b); });
    cortes = cortes.sort(function (x, y) { return x - y; })
      .filter(function (v, i, arr) { return i === 0 || v - arr[i - 1] > EPS; });
    var visibles = [];
    for (var i = 0; i < cortes.length - 1; i++) {
      var a = cortes[i], b = cortes[i + 1], mid = (a + b) / 2;
      var env = null, best = null;
      tramos.forEach(function (t) {            // envolvente: el 'ext' más cercano del tramo
        if (t.ext && t.a <= mid + EPS && t.b >= mid - EPS && (env == null || t.depth > env)) env = t.depth;
      });
      tramos.forEach(function (t) {
        if (t.a > mid + EPS || t.b < mid - EPS) return;
        if (!t.ext && env != null && t.depth < env - EPS) return;   // interior detrás del envolvente: oculto
        if (!best || t.depth > best.depth) best = t;
      });
      if (!best) continue;
      var last = visibles[visibles.length - 1];
      if (last && Math.abs(last.t.depth - best.depth) < EPS && Math.abs(last.b - a) < EPS) last.b = b;
      else visibles.push({ a: a, b: b, t: best });
    }
    return visibles.filter(function (v) { return v.b - v.a > SLIVER; });
  }

  /* proyección por orientación (ver cabecera para el espejado) */
  function project(geom, dir) {
    var horiz = (dir === 'S' || dir === 'N');
    var maxX = 0, maxY = 0;
    geom.walls.forEach(function (w) { maxX = Math.max(maxX, w.x1, w.x2); maxY = Math.max(maxY, w.y1, w.y2); });
    var sOf, dOf;
    if (dir === 'S') { sOf = function (u) { return u; }; dOf = function (f) { return f; }; }
    else if (dir === 'N') { sOf = function (u) { return maxX - u; }; dOf = function (f) { return -f; }; }
    else if (dir === 'E') { sOf = function (u) { return maxY - u; }; dOf = function (f) { return f; }; }
    else { sOf = function (u) { return u; }; dOf = function (f) { return -f; }; }   // 'O'
    return { horiz: horiz, sOf: sOf, dOf: dOf, maxX: maxX, maxY: maxY };
  }

  function facade(geom, dir, opts) {
    if (!geom || !geom.walls || !geom.walls.length || !LABELS[dir]) return null;
    opts = opts || {};
    var conTextos = opts.textos !== false;
    var avisos = [];

    var ev0 = geom.elev || {};
    var hMuro = num(ev0.hMuro, DEF.hMuro);
    var antepDef = num(ev0.antepecho, DEF.antepecho);
    var dintelDef = num(ev0.dintel, DEF.dintel);
    var pretil = (ev0.cubierta || DEF.cubierta) === 'losa' ? num(ev0.pretil, DEF.pretil) : 0;
    var hTot = hMuro + pretil;

    var p = project(geom, dir);

    /* ---- dominio del alzado: muros perpendiculares + envolvente exterior.
       OJO: el terreno (lot) NO recorta — si la casa está dibujada desplazada
       o más grande que el terreno capturado, la fachada saldría "en pedazos". */
    var hayExt = geom.walls.some(function (w) { return w.type === 'ext'; });
    var esExt = function (w) { return !hayExt || w.type === 'ext'; };   // sin tipos: todo es envolvente
    var domLo = -Infinity, domHi = Infinity, marcas = [];
    geom.walls.filter(p.horiz ? isV : isH).forEach(function (w) {       // perpendiculares (todas)
      marcas.push(p.horiz ? w.x1 : w.y1);
    });
    geom.walls.filter(p.horiz ? isH : isV).forEach(function (w) {       // paralelas EXTERIORES
      if (!esExt(w)) return;
      marcas.push(p.horiz ? w.x1 : w.y1, p.horiz ? w.x2 : w.y2);
    });
    if (marcas.length >= 2) { domLo = Math.min.apply(null, marcas); domHi = Math.max.apply(null, marcas); }

    /* ---- muros candidatos, recortados al dominio (en coords de mundo) ---- */
    var recortados = 0;
    var muros = [];
    geom.walls.filter(p.horiz ? isH : isV).forEach(function (w) {
      var u1 = p.horiz ? Math.min(w.x1, w.x2) : Math.min(w.y1, w.y2);
      var u2 = p.horiz ? Math.max(w.x1, w.x2) : Math.max(w.y1, w.y2);
      var c1 = Math.max(u1, domLo), c2 = Math.min(u2, domHi);
      if (c2 - c1 < SLIVER) { if (u2 - u1 > SLIVER) recortados++; return; }
      if (c1 - u1 > 0.05 || u2 - c2 > 0.05) recortados++;
      var s1 = p.sOf(c1), s2 = p.sOf(c2);
      muros.push({ a: Math.min(s1, s2), b: Math.max(s1, s2),
        depth: p.dOf(p.horiz ? w.y1 : w.x1), ext: esExt(w) });
    });
    if (!muros.length) return null;

    /* ---- fusión de planos casi-colineales (B1: sin costuras ni dobles) ---- */
    var reps = [], fusionados = 0;
    muros.sort(function (a, b) { return b.depth - a.depth; });
    muros.forEach(function (m) {
      for (var i = 0; i < reps.length; i++) {
        if (Math.abs(m.depth - reps[i]) <= DTOL) {
          if (Math.abs(m.depth - reps[i]) > 0.01) fusionados++;
          m.depth = reps[i]; return;
        }
      }
      reps.push(m.depth);
    });

    var visibles = sweep(muros);
    if (!visibles.length) return null;
    var frente = reps[0];                          // plano más cercano al observador

    var x0 = Math.min.apply(null, visibles.map(function (v) { return v.a; }));
    var x1 = Math.max.apply(null, visibles.map(function (v) { return v.b; }));
    var X = function (m) { return (m - x0) * PPM; };
    var Yc = function (m) { return (hTot - m) * PPM; };
    var wpx = (x1 - x0) * PPM;
    var idg = 'ckg' + dir;                         // ids únicos por fachada (la página 2 junta 4 en un svg)
    var g = '';

    /* ---- defs: cristal con gradiente ---- */
    g += '<defs>' +
      '<linearGradient id="' + idg + '" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#eaf2f4"/><stop offset="0.55" stop-color="#cfdde3"/><stop offset="1" stop-color="#e3edf0"/>' +
      '</linearGradient></defs>';

    /* ---- cuerpos de muro (sin contorno propio: la silueta es UNA) ---- */
    visibles.forEach(function (v) {
      var atFront = Math.abs(v.t.depth - frente) < EPS;
      g += el('rect', { x: X(v.a), y: Yc(hTot), width: (v.b - v.a) * PPM, height: hTot * PPM,
        fill: atFront ? MURO_F : MURO_R });
      // junta de losa: línea fina a la altura del lecho bajo del pretil (todos los planos)
      if (pretil) g += el('line', { x1: X(v.a), y1: Yc(hMuro), x2: X(v.b), y2: Yc(hMuro),
        stroke: NIVEL, 'stroke-width': PLUMA.detalle, opacity: 0.7 });
    });

    /* ---- cantos y sombra de canto en cambios de plano ---- */
    for (var i = 1; i < visibles.length; i++) {
      var prev = visibles[i - 1], cur = visibles[i];
      if (Math.abs(cur.a - prev.b) > EPS) continue;                  // hay hueco: lo cierra la silueta
      if (Math.abs(cur.t.depth - prev.t.depth) < EPS) continue;
      g += el('line', { x1: X(cur.a), y1: Yc(hTot), x2: X(cur.a), y2: Yc(0), stroke: TINTA, 'stroke-width': PLUMA.canto });
      // banda de sombra del lado retranqueado (lectura de profundidad)
      var sombraDer = cur.t.depth < prev.t.depth;                    // el más lejano recibe la sombra
      var sx = sombraDer ? X(cur.a) : X(cur.a) - 0.18 * PPM;
      g += el('rect', { x: sx, y: Yc(hTot), width: 0.18 * PPM, height: hTot * PPM, fill: 'rgba(43,43,43,0.09)' });
    }

    /* ---- silueta perimetral única por bloque contiguo (pluma gruesa) ---- */
    var run0 = null;
    function cerrarSilueta(a, b) {
      g += el('path', { d: 'M ' + X(a) + ' ' + Yc(0) + ' L ' + X(a) + ' ' + Yc(hTot) +
        ' L ' + X(b) + ' ' + Yc(hTot) + ' L ' + X(b) + ' ' + Yc(0),
        fill: 'none', stroke: TINTA, 'stroke-width': PLUMA.contorno, 'stroke-linejoin': 'miter' });
    }
    visibles.forEach(function (v, idx) {
      if (run0 == null) run0 = v.a;
      var next = visibles[idx + 1];
      if (!next || next.a - v.b > EPS) { cerrarSilueta(run0, v.b); run0 = null; }
    });

    /* ---- vanos: recortados al tramo visible de SU plano ---- */
    var tagVano = p.horiz ? 'h' : 'v';
    var vanoM2 = 0, nVanos = 0, omitidos = 0;
    function clipVano(u1, u2, fixedDepthRaw) {
      var s1 = p.sOf(u1), s2 = p.sOf(u2);
      var a = Math.min(s1, s2), b = Math.max(s1, s2);
      var d0 = p.dOf(fixedDepthRaw);
      // el vano hereda el plano FUSIONADO de su muro
      var depth = null;
      for (var i = 0; i < reps.length; i++) if (Math.abs(d0 - reps[i]) <= DTOL) { depth = reps[i]; break; }
      if (depth == null) return null;
      var iniW = b - a, ca = null, cb = null;
      visibles.forEach(function (v) {
        if (Math.abs(v.t.depth - depth) > EPS) return;
        var ia = Math.max(a, v.a), ib = Math.min(b, v.b);
        if (ib - ia <= 0) return;
        if (ca == null || ia < ca) ca = ia;
        if (cb == null || ib > cb) cb = ib;
      });
      if (ca == null || cb - ca < Math.max(0.15, iniW * 0.3)) return null;   // casi todo oculto: fuera
      return { a: ca, b: cb, recortado: (cb - ca) < iniW - 0.02 };
    }
    function marcaOverride(xpx, ypx) {             // triángulo acento: este vano usa alturas propias
      return el('path', { d: 'M ' + xpx + ' ' + ypx + ' l 7 0 l -7 7 z', fill: ACENTO, opacity: 0.9 });
    }

    (geom.windows || []).forEach(function (o) {
      if (o.wall !== tagVano) return;
      var c = clipVano(o.a, o.b, o.fixed);
      if (!c) { omitidos++; return; }
      var ant = num(o.z && o.z.antepecho, antepDef);
      var top = (o.z && typeof o.z.alto === 'number') ? ant + o.z.alto : dintelDef;
      var vx = X(c.a), vw = (c.b - c.a) * PPM, vy = Yc(top), vh = (top - ant) * PPM;
      g += el('rect', { x: vx - 2, y: vy - 2, width: vw + 4, height: vh + 4, fill: '#fff',
        stroke: TINTA, 'stroke-width': PLUMA.vano, 'data-kind': 'window', 'data-id': o.id });   // marco
      g += el('rect', { x: vx + 2, y: vy + 2, width: vw - 4, height: vh - 4, fill: 'url(#' + idg + ')' });
      g += el('line', { x1: vx + vw / 2, y1: vy + 2, x2: vx + vw / 2, y2: vy + vh - 2, stroke: '#5d6a70', 'stroke-width': 1.1 });
      g += el('line', { x1: vx + 2, y1: vy + vh / 2, x2: vx + vw - 2, y2: vy + vh / 2, stroke: '#5d6a70', 'stroke-width': 0.9 });
      g += el('line', { x1: vx + vw * 0.16, y1: vy + vh * 0.34, x2: vx + vw * 0.34, y2: vy + vh * 0.12,
        stroke: '#ffffff', 'stroke-width': 1.6, opacity: 0.75 });                                // destello
      g += el('rect', { x: vx - 4.5, y: Yc(ant) + 2, width: vw + 9, height: 3.6, fill: '#ddd5c9',
        stroke: TINTA, 'stroke-width': PLUMA.detalle });                                         // repisón
      if (o.z) g += marcaOverride(vx - 2, vy - 2);
      vanoM2 += (c.b - c.a) * (top - ant); nVanos++;
    });

    (geom.sliders || []).forEach(function (o) {
      if (o.wall !== tagVano) return;
      var c = clipVano(o.a, o.b, o.fixed);
      if (!c) { omitidos++; return; }
      var top = (o.z && typeof o.z.alto === 'number') ? o.z.alto : dintelDef;
      var vx = X(c.a), vw = (c.b - c.a) * PPM, vy = Yc(top), vh = top * PPM;
      g += el('rect', { x: vx - 2, y: vy - 2, width: vw + 4, height: vh + 2, fill: '#fff',
        stroke: TINTA, 'stroke-width': PLUMA.vano, 'data-kind': 'slider', 'data-id': o.id });
      g += el('rect', { x: vx + 2, y: vy + 2, width: vw - 4, height: vh - 4, fill: 'url(#' + idg + ')' });
      g += el('line', { x1: vx + vw / 2, y1: vy, x2: vx + vw / 2, y2: vy + vh, stroke: '#5d6a70', 'stroke-width': 1.8 });
      g += el('line', { x1: vx, y1: vy + vh - 3, x2: vx + vw, y2: vy + vh - 3, stroke: '#5d6a70', 'stroke-width': 1 });  // riel
      g += el('line', { x1: vx + vw * 0.10, y1: vy + vh * 0.30, x2: vx + vw * 0.26, y2: vy + vh * 0.10,
        stroke: '#ffffff', 'stroke-width': 1.6, opacity: 0.75 });
      if (o.z) g += marcaOverride(vx - 2, vy - 2);
      vanoM2 += (c.b - c.a) * top; nVanos++;
    });

    (geom.doors || []).forEach(function (d) {
      if (d.wall !== tagVano) return;
      var spn = (p.horiz ? d.along[0] : d.along[1]) * d.w;
      var pos = p.horiz ? d.hx : d.hy;
      var fix = p.horiz ? d.hy : d.hx;
      var c = clipVano(Math.min(pos, pos + spn), Math.max(pos, pos + spn), fix);
      if (!c) { omitidos++; return; }
      var top = (d.z && typeof d.z.alto === 'number') ? d.z.alto : dintelDef;
      var vx = X(c.a), vw = (c.b - c.a) * PPM, vy = Yc(top), vh = top * PPM;
      g += el('rect', { x: vx, y: vy, width: vw, height: vh, fill: '#cfa98a',
        stroke: TINTA, 'stroke-width': PLUMA.vano, 'data-kind': 'door', 'data-id': d.id });      // hoja
      g += el('rect', { x: vx + vw * 0.18, y: vy + vh * 0.10, width: vw * 0.64, height: vh * 0.46,
        fill: 'none', stroke: '#9c7a58', 'stroke-width': PLUMA.detalle });                       // tablero
      g += el('rect', { x: vx + vw * 0.18, y: vy + vh * 0.62, width: vw * 0.64, height: vh * 0.28,
        fill: 'none', stroke: '#9c7a58', 'stroke-width': PLUMA.detalle });
      g += el('circle', { cx: vx + vw - 7, cy: vy + vh * 0.52, r: 2.2, fill: '#4a443c' });       // manija
      g += el('line', { x1: vx - 3, y1: Yc(0), x2: vx + vw + 3, y2: Yc(0), stroke: TINTA, 'stroke-width': 2.4 });  // umbral
      if (d.z) g += marcaOverride(vx, vy);
      vanoM2 += (c.b - c.a) * top; nVanos++;
    });

    /* ---- terreno: línea dominante + hachurado ---- */
    g += el('line', { x1: -0.6 * PPM, y1: Yc(0), x2: wpx + 0.6 * PPM, y2: Yc(0), stroke: TINTA, 'stroke-width': PLUMA.contorno });
    var hach = '';
    for (var hx = -0.45 * PPM; hx < wpx + 0.45 * PPM; hx += 0.34 * PPM) {
      hach += el('line', { x1: hx + 7, y1: Yc(0) + 2, x2: hx, y2: Yc(0) + 11, stroke: NIVEL, 'stroke-width': PLUMA.detalle });
    }
    g += el('g', { opacity: 0.8 }, hach);

    /* ---- niveles raya-punto FUERA del volumen ---- */
    var nivs = [{ m: 0, lbl: 'NPT ±0.00' }, { m: hMuro, lbl: '+' + hMuro.toFixed(2) }];
    if (pretil) nivs.push({ m: hTot, lbl: '+' + hTot.toFixed(2) });
    nivs.forEach(function (n) {
      g += el('line', { x1: -0.55 * PPM, y1: Yc(n.m), x2: wpx + 0.55 * PPM, y2: Yc(n.m),
        stroke: NIVEL, 'stroke-width': PLUMA.detalle, 'stroke-dasharray': '13 5 2.5 5' });
      if (conTextos) g += txt(-0.62 * PPM, Yc(n.m) - 3, n.lbl, 9.5, { 'text-anchor': 'end' });
    });

    /* ---- cota vertical de alturas (lado derecho, fuera) ---- */
    if (conTextos) {
      var cotas = [0, antepDef, dintelDef, hMuro]; if (pretil) cotas.push(hTot);
      cotas = cotas.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (a, b) { return a - b; });
      var cx = wpx + 0.55 * PPM;
      g += el('line', { x1: cx, y1: Yc(cotas[0]), x2: cx, y2: Yc(cotas[cotas.length - 1]), stroke: ACENTO, 'stroke-width': PLUMA.detalle });
      cotas.forEach(function (m) {
        g += el('line', { x1: cx - 4, y1: Yc(m) + 4, x2: cx + 4, y2: Yc(m) - 4, stroke: ACENTO, 'stroke-width': 1 });
        if (m > 0) g += txt(cx + 7, Yc(m) + 3, m.toFixed(2), 9, { fill: ACENTO, 'text-anchor': 'start' });
      });
    }

    /* ---- cotas vivas + halo del vano resaltado (editor de fachadas) ---- */
    if (opts.resaltar) {
      var rk = opts.resaltar.kind, rid = opts.resaltar.id;
      var sel = (rk === 'window' ? geom.windows : rk === 'slider' ? geom.sliders : geom.doors || [])
        .filter(function (o) { return o.id === rid; })[0];
      if (sel && sel.wall === tagVano) {
        var su1 = rk === 'door' ? Math.min(sel.hx, sel.hx + sel.along[0] * sel.w) : sel.a;
        var su2 = rk === 'door' ? Math.max(sel.hx, sel.hx + sel.along[0] * sel.w) : sel.b;
        if (!p.horiz && rk === 'door') { su1 = Math.min(sel.hy, sel.hy + sel.along[1] * sel.w); su2 = Math.max(sel.hy, sel.hy + sel.along[1] * sel.w); }
        var cc = clipVano(su1, su2, rk === 'door' ? (p.horiz ? sel.hy : sel.hx) : sel.fixed);
        if (cc) {
          var sAnt = rk === 'window' ? num(sel.z && sel.z.antepecho, antepDef) : 0;
          var sTop = (sel.z && typeof sel.z.alto === 'number') ? (rk === 'window' ? sAnt + sel.z.alto : sel.z.alto) : dintelDef;
          var hx2 = X(cc.a), hw = (cc.b - cc.a) * PPM;
          g += el('rect', { x: hx2 - 4, y: Yc(sTop) - 4, width: hw + 8, height: (sTop - sAnt) * PPM + 8,
            fill: 'none', stroke: ACENTO, 'stroke-width': 3, 'stroke-dasharray': '7 4' });
          // cotas vivas a la izquierda del vano (estilo dimensiones temporales)
          var dvx = hx2 - 0.32 * PPM;
          function dim(m1, m2, label) {
            g += el('line', { x1: dvx, y1: Yc(m1), x2: dvx, y2: Yc(m2), stroke: ACENTO, 'stroke-width': 1.2 });
            [m1, m2].forEach(function (m) { g += el('line', { x1: dvx - 4, y1: Yc(m), x2: dvx + 4, y2: Yc(m), stroke: ACENTO, 'stroke-width': 1.2 }); });
            g += txt(dvx - 6, (Yc(m1) + Yc(m2)) / 2 + 3, label, 10.5, { fill: ACENTO, 'text-anchor': 'end', 'font-weight': 700 });
          }
          if (sAnt > 0) dim(0, sAnt, sAnt.toFixed(2));
          dim(sAnt, sTop, (sTop - sAnt).toFixed(2));
        }
      }
    }

    /* ---- avisos de modelo (estilo validador) ---- */
    if (recortados) avisos.push(recortados + ' muro(s) se recortaron al perímetro');
    if (fusionados) avisos.push('muros casi alineados se fusionaron (' + fusionados + ')');
    if (omitidos) avisos.push(omitidos + ' vano(s) quedaron fuera de la fachada');

    var muroM2 = 0;
    visibles.forEach(function (v) { muroM2 += (v.b - v.a) * hMuro; });

    return {
      svg: g,
      widthM: x1 - x0,
      heightM: hTot + 0.25,
      label: LABELS[dir],
      dir: dir,
      stats: { muroM2: Math.round(muroM2 * 100) / 100, vanoM2: Math.round(vanoM2 * 100) / 100,
               pctHuecos: muroM2 ? Math.round(vanoM2 / muroM2 * 1000) / 10 : 0, nVanos: nVanos },
      avisos: avisos
    };
  }

  function allFacades(geom, opts) {
    return ['S', 'N', 'E', 'O'].map(function (d) { return facade(geom, d, opts); })
      .filter(function (f) { return !!f; });
  }
  function frontFacade(geom) { return facade(geom, 'S'); }

  window.PlanElev = { facade: facade, allFacades: allFacades, frontFacade: frontFacade };
  if (window.PlanSheet) window.PlanSheet.setElevProvider(frontFacade);   // integración con la lámina
})();
