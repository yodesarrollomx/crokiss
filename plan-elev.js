/* =============================================================
   CroKiss — Fachadas automáticas, fase F1 (plan-elev.js)
   Genera la FACHADA PRINCIPAL (alzado 2D) proyectando los muros
   horizontales de la planta vistos desde el frente (sur = y mayor),
   con oclusión por barrido de intervalos 1D y vanos a su altura
   según geom.elev { hMuro, antepecho, dintel, cubierta } y el
   override opcional por vano (vano.z = { antepecho, alto }).
   Se registra como proveedor de fachada de plan-sheet.js.
   F1 (limitaciones conocidas): solo fachada frontal; muros oblicuos
   se omiten; muros retranqueados se dibujan en gris sin sombra.
   F2 capturará alturas por vano en la UI; F4 añadirá las 4 fachadas.
   API:  PlanElev.frontFacade(geom) → {svg, widthM, heightM, label}
   ============================================================= */
(function () {
  'use strict';

  var PPM = 74;                                   // px por metro (mismo del plano)
  var MURO = '#2b2b2b', RETRO = '#8d8579', DET = '#6b6256';
  var DEF = { hMuro: 2.40, antepecho: 0.90, dintel: 2.10, cubierta: 'losa' };
  var EPS = 1e-6;

  function el(tag, attrs, inner) {
    var s = '<' + tag;
    for (var k in attrs) s += ' ' + k + '="' + attrs[k] + '"';
    return s + (inner != null ? '>' + inner + '</' + tag + '>' : '/>');
  }
  var isH = function (w) { return Math.abs(w.y1 - w.y2) < EPS; };
  var isV = function (w) { return Math.abs(w.x1 - w.x2) < EPS; };

  /* barrido 1D: de una lista de tramos {a,b,depth,...} se queda con el más
     cercano al observador (depth mayor = más al sur) en cada subintervalo */
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

  function frontFacade(geom) {
    if (!geom || !geom.walls || !geom.walls.length) return null;
    var ev = geom.elev || DEF;
    var hMuro = ev.hMuro || DEF.hMuro;
    var T = (geom.wallCm || 20) / 100;

    // candidatos: muros horizontales (frente = vistos desde el sur, y mayor)
    var muros = geom.walls.filter(isH).map(function (w) {
      return { a: Math.min(w.x1, w.x2), b: Math.max(w.x1, w.x2), depth: w.y1, w: w };
    }).filter(function (t) { return t.b - t.a > 0.05; });
    if (!muros.length) return null;

    var visibles = sweep(muros);
    if (!visibles.length) return null;
    var frente = Math.max.apply(null, muros.map(function (t) { return t.depth; }));

    var x0 = Math.min.apply(null, visibles.map(function (v) { return v.a; }));
    var x1 = Math.max.apply(null, visibles.map(function (v) { return v.b; }));
    var pretil = (ev.cubierta || 'losa') === 'losa' ? 0.35 : 0;
    var hTot = hMuro + pretil;
    var X = function (m) { return (m - x0) * PPM; };
    var Yc = function (m) { return (hTot - m) * PPM; };          // 0 = piso, hacia arriba
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

    // vanos sobre los tramos visibles (asociación geométrica al muro)
    function visibleEn(a, b, fixed) {
      return visibles.some(function (v) {
        return Math.abs(v.t.depth - fixed) < EPS && a < v.b - EPS && b > v.a + EPS;
      });
    }
    (geom.windows || []).forEach(function (o) {
      if (o.wall !== 'h' || !visibleEn(o.a, o.b, o.fixed)) return;
      var ant = (o.z && o.z.antepecho != null) ? o.z.antepecho : (ev.antepecho || DEF.antepecho);
      var top = (o.z && o.z.alto != null) ? ant + o.z.alto : (ev.dintel || DEF.dintel);
      g += el('rect', { x: X(o.a), y: Yc(top), width: (o.b - o.a) * PPM, height: (top - ant) * PPM,
        fill: '#dde6e8', stroke: MURO, 'stroke-width': 1.3 });
      g += el('line', { x1: X(o.a), y1: Yc((top + ant) / 2), x2: X(o.b), y2: Yc((top + ant) / 2), stroke: DET, 'stroke-width': 0.6 });
    });
    (geom.sliders || []).forEach(function (o) {                  // corrediza: cristal de piso a dintel
      if (o.wall !== 'h' || !visibleEn(o.a, o.b, o.fixed)) return;
      var top = (o.z && o.z.alto != null) ? o.z.alto : (ev.dintel || DEF.dintel);
      var mid = (o.a + o.b) / 2;
      g += el('rect', { x: X(o.a), y: Yc(top), width: (o.b - o.a) * PPM, height: top * PPM, fill: '#dde6e8', stroke: MURO, 'stroke-width': 1.3 });
      g += el('line', { x1: X(mid), y1: Yc(top), x2: X(mid), y2: Yc(0), stroke: DET, 'stroke-width': 0.8 });
    });
    (geom.doors || []).forEach(function (d) {
      if (d.wall !== 'h') return;
      var spn = d.along[0] * d.w;
      var a = Math.min(d.hx, d.hx + spn), b = Math.max(d.hx, d.hx + spn);
      if (!visibleEn(a, b, d.hy)) return;
      var top = (d.z && d.z.alto != null) ? d.z.alto : (ev.dintel || DEF.dintel);
      g += el('rect', { x: X(a), y: Yc(top), width: (b - a) * PPM, height: top * PPM, fill: '#efe9e2', stroke: MURO, 'stroke-width': 1.3 });
      g += el('circle', { cx: X(b) - 0.12 * PPM, cy: Yc(top / 2), r: 1.6, fill: DET });   // pomo
    });

    // línea de terreno natural
    g += el('line', { x1: -6, y1: Yc(0), x2: (x1 - x0) * PPM + 6, y2: Yc(0), stroke: MURO, 'stroke-width': 2.4 });

    return { svg: g, widthM: x1 - x0, heightM: hTot + 0.15, label: 'FACHADA PRINCIPAL' };
  }

  window.PlanElev = { frontFacade: frontFacade };
  if (window.PlanSheet) window.PlanSheet.setElevProvider(frontFacade);   // integración con la lámina
})();
