/* =============================================================
   CroKiss — Fachadas automáticas, fase F4 (plan-elev.js)
   Genera los ALZADOS 2D de las cuatro orientaciones proyectando
   los muros de la planta (horizontales para S/N, verticales para
   E/O) con oclusión por barrido de intervalos 1D y vanos a su
   altura según geom.elev { hMuro, antepecho, dintel, cubierta,
   pretil } y el override opcional por vano (ventana
   vano.z = { antepecho, alto }; puerta/corrediza vano.z = { alto }).
   Espejado: el observador siempre mira HACIA la casa —
     S: s = x · N: s = maxX − x · E: s = maxY − y · O: s = y.
   Cada figura de vano lleva data-kind/data-id para que el editor
   de fachadas pueda seleccionarla con clic. Incluye líneas de
   nivel discretas (NPT ±0.00 y +hMuro).
   Limitaciones conocidas: muros oblicuos se omiten; retranqueos
   sin sombra (se dibujan en gris).
   API:  PlanElev.facade(geom, dir)  dir ∈ 'S'|'N'|'E'|'O'
           → { svg, widthM, heightM, label, dir } | null
         PlanElev.allFacades(geom) → [fachadas no nulas]
         PlanElev.frontFacade(geom) — alias de facade(geom,'S')
   ============================================================= */
(function () {
  'use strict';

  var PPM = 74;                                   // px por metro (mismo del plano)
  var MURO = '#2b2b2b', RETRO = '#8d8579', DET = '#6b6256', NIVEL = '#9a9087';
  var DEF = { hMuro: 2.40, antepecho: 0.90, dintel: 2.10, cubierta: 'losa', pretil: 0.35 };
  var EPS = 1e-6;
  var LABELS = { S: 'FACHADA SUR', N: 'FACHADA NORTE', E: 'FACHADA ORIENTE', O: 'FACHADA PONIENTE' };

  function el(tag, attrs, inner) {
    var s = '<' + tag;
    for (var k in attrs) s += ' ' + k + '="' + attrs[k] + '"';
    return s + (inner != null ? '>' + inner + '</' + tag + '>' : '/>');
  }
  var isH = function (w) { return Math.abs(w.y1 - w.y2) < EPS; };
  var isV = function (w) { return Math.abs(w.x1 - w.x2) < EPS; };

  /* barrido 1D: de una lista de tramos {a,b,depth,...} se queda con el más
     cercano al observador (depth mayor = más cerca) en cada subintervalo */
  function sweep(tramos) {
    var cortes = [];
    tramos.forEach(function (t) { cortes.push(t.a, t.b); });
    cortes = cortes.sort(function (x, y) { return x - y; })
      .filter(function (v, i, arr) { return i === 0 || v - arr[i - 1] > EPS; });
    var visibles = [];
    for (var i = 0; i < cortes.length - 1; i++) {
      var a = cortes[i], b = cortes[i + 1], mid = (a + b) / 2, best = null;
      tramos.forEach(function (t) {
        if (t.a <= mid + EPS && t.b >= mid - EPS && (!best || t.depth > best.depth)) best = t;
      });
      if (!best) continue;
      var last = visibles[visibles.length - 1];
      // fusiona tramos contiguos a la MISMA profundidad (aunque sean muros
      // colineales distintos): el frente continuo no debe mostrar costuras
      if (last && Math.abs(last.t.depth - best.depth) < EPS && Math.abs(last.b - a) < EPS) last.b = b;
      else visibles.push({ a: a, b: b, t: best });
    }
    return visibles;
  }

  /* Proyección por orientación: selecciona muros candidatos y define las
     funciones de mapeo a pantalla (s) y profundidad (depth, mayor = más
     cerca del observador, que mira HACIA la casa):
       S: muros h, s = x,        depth = y    (frente = y mayor, sur)
       N: muros h, s = maxX − x, depth = −y   (frente = y menor)
       E: muros v, s = maxY − y, depth = x    (mira al poniente)
       O: muros v, s = y,        depth = −x   (mira al oriente)        */
  function project(geom, dir) {
    var horiz = (dir === 'S' || dir === 'N');
    var maxX = -Infinity, maxY = -Infinity;
    geom.walls.forEach(function (w) {
      maxX = Math.max(maxX, w.x1, w.x2);
      maxY = Math.max(maxY, w.y1, w.y2);
    });
    var sOf, dOf;                                  // s: coordenada de pantalla · depth
    if (dir === 'S') { sOf = function (u) { return u; }; dOf = function (f) { return f; }; }
    else if (dir === 'N') { sOf = function (u) { return maxX - u; }; dOf = function (f) { return -f; }; }
    else if (dir === 'E') { sOf = function (u) { return maxY - u; }; dOf = function (f) { return f; }; }
    else { sOf = function (u) { return u; }; dOf = function (f) { return -f; }; }   // 'O'

    var muros = geom.walls.filter(horiz ? isH : isV).map(function (w) {
      var u1 = horiz ? w.x1 : w.y1, u2 = horiz ? w.x2 : w.y2;
      var s1 = sOf(u1), s2 = sOf(u2);
      return { a: Math.min(s1, s2), b: Math.max(s1, s2),
        depth: dOf(horiz ? w.y1 : w.x1), w: w };
    }).filter(function (t) { return t.b - t.a > 0.05; });

    return { horiz: horiz, muros: muros, sOf: sOf, dOf: dOf };
  }

  function facade(geom, dir) {
    if (!geom || !geom.walls || !geom.walls.length || !LABELS[dir]) return null;
    var ev = geom.elev || DEF;
    var hMuro = ev.hMuro || DEF.hMuro;

    var p = project(geom, dir);
    if (!p.muros.length) return null;
    var visibles = sweep(p.muros);
    if (!visibles.length) return null;
    var frente = Math.max.apply(null, p.muros.map(function (t) { return t.depth; }));

    var x0 = Math.min.apply(null, visibles.map(function (v) { return v.a; }));
    var x1 = Math.max.apply(null, visibles.map(function (v) { return v.b; }));
    var pretil = (ev.cubierta || 'losa') === 'losa'
      ? (ev.pretil != null ? ev.pretil : DEF.pretil) : 0;
    var hTot = hMuro + pretil;
    var X = function (m) { return (m - x0) * PPM; };
    var Yc = function (m) { return (hTot - m) * PPM; };          // 0 = piso, hacia arriba
    var wpx = (x1 - x0) * PPM;
    var g = '';

    // cuerpos de muro visibles (el frente sólido; lo retranqueado en gris)
    visibles.forEach(function (v) {
      var atFront = Math.abs(v.t.depth - frente) < 0.5;          // medio metro de tolerancia
      g += el('rect', { x: X(v.a), y: Yc(hMuro), width: (v.b - v.a) * PPM, height: hMuro * PPM,
        fill: atFront ? '#f4f2ee' : '#e7e3dc', stroke: atFront ? MURO : RETRO, 'stroke-width': atFront ? 2 : 1.2 });
      if (pretil && atFront) {                                   // pretil de losa
        g += el('rect', { x: X(v.a), y: Yc(hTot), width: (v.b - v.a) * PPM, height: pretil * PPM,
          fill: '#f4f2ee', stroke: MURO, 'stroke-width': 2 });
      }
    });

    // aristas verticales donde cambia la profundidad (cantos perpendiculares)
    for (var i = 1; i < visibles.length; i++) {
      if (Math.abs(visibles[i].t.depth - visibles[i - 1].t.depth) > EPS &&
          Math.abs(visibles[i].a - visibles[i - 1].b) < EPS) {
        g += el('line', { x1: X(visibles[i].a), y1: Yc(hMuro), x2: X(visibles[i].a), y2: Yc(0), stroke: MURO, 'stroke-width': 1.4 });
      }
    }

    // vanos sobre los tramos visibles (asociación geométrica al muro);
    // el espejado puede invertir a/b, por eso se reordena tras mapear
    var tagVano = p.horiz ? 'h' : 'v';
    function visibleEn(a, b, depth) {
      return visibles.some(function (v) {
        return Math.abs(v.t.depth - depth) < EPS && a < v.b - EPS && b > v.a + EPS;
      });
    }
    function mapVano(u1, u2, fixed) {
      var s1 = p.sOf(u1), s2 = p.sOf(u2);
      return { a: Math.min(s1, s2), b: Math.max(s1, s2), depth: p.dOf(fixed) };
    }
    (geom.windows || []).forEach(function (o) {
      if (o.wall !== tagVano) return;
      var m = mapVano(o.a, o.b, o.fixed);
      if (!visibleEn(m.a, m.b, m.depth)) return;
      var ant = (o.z && o.z.antepecho != null) ? o.z.antepecho : (ev.antepecho || DEF.antepecho);
      var top = (o.z && o.z.alto != null) ? ant + o.z.alto : (ev.dintel || DEF.dintel);
      g += el('rect', { x: X(m.a), y: Yc(top), width: (m.b - m.a) * PPM, height: (top - ant) * PPM,
        fill: '#dde6e8', stroke: MURO, 'stroke-width': 1.3, 'data-kind': 'window', 'data-id': o.id });
      g += el('line', { x1: X(m.a), y1: Yc((top + ant) / 2), x2: X(m.b), y2: Yc((top + ant) / 2), stroke: DET, 'stroke-width': 0.6 });
    });
    (geom.sliders || []).forEach(function (o) {                  // corrediza: cristal de piso a dintel
      if (o.wall !== tagVano) return;
      var m = mapVano(o.a, o.b, o.fixed);
      if (!visibleEn(m.a, m.b, m.depth)) return;
      var top = (o.z && o.z.alto != null) ? o.z.alto : (ev.dintel || DEF.dintel);
      var mid = (m.a + m.b) / 2;
      g += el('rect', { x: X(m.a), y: Yc(top), width: (m.b - m.a) * PPM, height: top * PPM,
        fill: '#dde6e8', stroke: MURO, 'stroke-width': 1.3, 'data-kind': 'slider', 'data-id': o.id });
      g += el('line', { x1: X(mid), y1: Yc(top), x2: X(mid), y2: Yc(0), stroke: DET, 'stroke-width': 0.8 });
    });
    (geom.doors || []).forEach(function (d) {
      if (d.wall !== tagVano) return;
      // en muros horizontales la hoja corre en x (along[0]); en verticales en y (along[1])
      var pos = p.horiz ? d.hx : d.hy;
      var spn = (p.horiz ? d.along[0] : d.along[1]) * d.w;
      var fixed = p.horiz ? d.hy : d.hx;
      var m = mapVano(pos, pos + spn, fixed);
      if (!visibleEn(m.a, m.b, m.depth)) return;
      var top = (d.z && d.z.alto != null) ? d.z.alto : (ev.dintel || DEF.dintel);
      g += el('rect', { x: X(m.a), y: Yc(top), width: (m.b - m.a) * PPM, height: top * PPM,
        fill: '#efe9e2', stroke: MURO, 'stroke-width': 1.3, 'data-kind': 'door', 'data-id': d.id });
      g += el('circle', { cx: X(m.b) - 0.12 * PPM, cy: Yc(top / 2), r: 1.6, fill: DET });   // pomo
    });

    // líneas de nivel discretas: NPT ±0.00 (piso) y nivel superior (+hMuro)
    [{ z: 0, txt: 'NPT ±0.00' }, { z: hMuro, txt: '+' + hMuro.toFixed(2) }].forEach(function (n) {
      g += el('line', { x1: -16, y1: Yc(n.z), x2: wpx + 16, y2: Yc(n.z),
        stroke: NIVEL, 'stroke-width': 0.7, 'stroke-dasharray': '5 4' });
      g += el('text', { x: -14, y: Yc(n.z) - 3, 'font-size': 9, fill: NIVEL,
        'font-family': 'inherit' }, n.txt);
    });

    // línea de terreno natural
    g += el('line', { x1: -6, y1: Yc(0), x2: wpx + 6, y2: Yc(0), stroke: MURO, 'stroke-width': 2.4 });

    return { svg: g, widthM: x1 - x0, heightM: hTot + 0.15, label: LABELS[dir], dir: dir };
  }

  function allFacades(geom) {
    return ['S', 'N', 'E', 'O'].map(function (d) { return facade(geom, d); })
      .filter(function (f) { return !!f; });
  }

  function frontFacade(geom) { return facade(geom, 'S'); }   // alias de compatibilidad (F1)

  window.PlanElev = { facade: facade, allFacades: allFacades, frontFacade: frontFacade };
  if (window.PlanSheet) window.PlanSheet.setElevProvider(frontFacade);   // integración con la lámina
})();
