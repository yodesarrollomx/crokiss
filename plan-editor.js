/* ============================================================
   Editor interactivo de muros y ventanas — Proyecto Marbel
   Arrastra muros (cuerpo o extremos), ventanas y puertas.
   Snap a retícula, longitudes en vivo, undo, exportar resumen.
   Coordenadas: metros, origen sup-izq, y crece hacia abajo.
   ============================================================ */
(function () {
  'use strict';

  // ---------- utilidades svg ----------
  function el(tag, attrs, inner) {
    let s = '<' + tag;
    for (const k in attrs) s += ' ' + k + '="' + attrs[k] + '"';
    s += inner != null ? '>' + inner + '</' + tag + '>' : '/>';
    return s;
  }
  const round2 = (v) => Math.round(v * 100) / 100;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v) => round2(v).toFixed(2);
  const DEF_BLOCK_LEN = 0.40, DEF_JOINT = 0.01;   // block 40 cm, junta 1 cm (por defecto)

  // ---------- geometría inicial (clon de PlanRender) ----------
  function defaultGeom() {
    const G = (window.PlanRender && window.PlanRender.GEOMETRY) || {};
    const walls = (G.WALLS || []).map((w, i) => ({
      id: 'w' + i, type: w[0], x1: w[1], y1: w[2], x2: w[3], y2: w[4],
    }));
    const windows = (G.WINDOWS || []).map((w, i) => ({
      id: 'v' + i, wall: w.wall, fixed: w.fixed, a: w.a, b: w.b,
    }));
    const doors = (G.DOORS || []).map((d, i) => ({
      id: 'd' + i, wall: d.wall, hx: d.hx, hy: d.hy, w: d.w,
      along: d.along.slice(), open: d.open.slice(),
    }));
    const sliders = (G.SLIDERS || []).map((s, i) => ({
      id: 's' + i, wall: s.wall, fixed: s.fixed, a: s.a, b: s.b,
    }));
    return { walls, windows, doors, sliders, furniture: [] };
  }

  // id único para elementos nuevos
  function nid(p) { return p + 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1000); }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function PlanEditor(mountId) {
    const KEY = 'marbel_editor_geom_v1';
    const root = document.getElementById(mountId);

    let geom, snap = 0.10, wallCm = 20, showLen = true, sel = null, placing = null, blockMode = true;
    const history = [];
    let redo = [];

    // ---- zoom / desplazamiento (solo vista; no altera la geometría) ----
    let vb = null, panMode = false, spaceDown = false, panning = null;
    const ptrs = new Map();            // punteros activos (para pinch de 2 dedos)
    let pinch = null;                  // gesto de zoom/pan con 2 dedos

    const fin = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;   // número finito o default
    const cleanId = (v) => String(v == null ? '' : v).replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40);
    function normalize() {
      if (!geom || typeof geom !== 'object') geom = {};
      geom.walls = Array.isArray(geom.walls) ? geom.walls : [];
      geom.windows = Array.isArray(geom.windows) ? geom.windows : [];
      geom.doors = Array.isArray(geom.doors) ? geom.doors : [];
      geom.sliders = Array.isArray(geom.sliders) ? geom.sliders : [];
      geom.furniture = Array.isArray(geom.furniture) ? geom.furniture : [];
      geom.labels = Array.isArray(geom.labels) ? geom.labels : [];
      // rangos seguros: evita el cuelgue por blockLen<=0 o joint<0 en wallBlocks()
      geom.blockLen = Math.max(0.10, fin(geom.blockLen, DEF_BLOCK_LEN));
      geom.joint = Math.max(0, fin(geom.joint, DEF_JOINT));
      // saneo de coordenadas (import de JSON o nube corrupta no rompe el motor)
      geom.walls = geom.walls.filter((w) => w && ['x1','y1','x2','y2'].every((k) => isFinite(w[k])));
      geom.walls.forEach((w) => { w.id = cleanId(w.id) || nid('w'); w.type = cleanId(w.type) || 'int'; if (!Array.isArray(w.re)) w.re = []; });
      geom.windows.forEach((o) => { o.id = cleanId(o.id) || nid('v'); o.a = fin(o.a, 0); o.b = fin(o.b, o.a + 0.5); o.fixed = fin(o.fixed, 0); });
      geom.sliders.forEach((o) => { o.id = cleanId(o.id) || nid('s'); o.a = fin(o.a, 0); o.b = fin(o.b, o.a + 0.5); o.fixed = fin(o.fixed, 0); });
      geom.doors.forEach((o) => { o.id = cleanId(o.id) || nid('d'); o.hx = fin(o.hx, 0); o.hy = fin(o.hy, 0); o.w = Math.max(0.40, fin(o.w, 0.8)); if (!Array.isArray(o.along)) o.along = [1,0]; if (!Array.isArray(o.open)) o.open = [0,1]; });
      geom.furniture.forEach((f) => { f.id = cleanId(f.id) || nid('f'); f.type = cleanId(f.type) || 'mesa'; f.cx = fin(f.cx, 0); f.cy = fin(f.cy, 0); f.w = Math.max(0.10, fin(f.w, 1)); f.h = Math.max(0.10, fin(f.h, 1)); f.rot = fin(f.rot, 0); });
      geom.labels = geom.labels.filter((l) => l && isFinite(l.cx) && isFinite(l.cy));
      geom.labels.forEach((l) => { l.id = cleanId(l.id) || nid('t'); l.text = String(l.text == null ? '' : l.text).slice(0, 40); });
      geom.schemaVersion = 1;
    }

    // ---- persistencia ----
    function load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) { geom = JSON.parse(raw); normalize(); return; }
      } catch (e) {}
      geom = defaultGeom(); normalize();
    }
    function save() {
      try { localStorage.setItem(KEY, JSON.stringify(geom)); } catch (e) {}
    }
    function pushHistory() {
      history.push(JSON.stringify(geom));
      if (history.length > 60) history.shift();
      redo = [];                                     // una acción nueva invalida el rehacer
    }
    function clearHistory() { history.length = 0; redo = []; }   // al abrir otro proyecto/terreno
    function undo() {
      if (!history.length) return;
      redo.push(JSON.stringify(geom)); if (redo.length > 60) redo.shift();
      geom = JSON.parse(history.pop());
      normalize(); sel = null; save(); render();
    }
    function redoAct() {
      if (!redo.length) return;
      history.push(JSON.stringify(geom));
      geom = JSON.parse(redo.pop());
      normalize(); sel = null; save(); render();
    }
    function reset() {
      pushHistory(); geom = defaultGeom(); sel = null; save(); render();
    }

    // ---- snap ----
    const snapV = (v) => round2(snap > 0 ? Math.round(v / snap) * snap : Math.round(v * 100) / 100);

    // ---- layout px ----
    const PPM = 74, OX = 150, OY = 150;
    const X = (m) => OX + m * PPM;
    const Y = (m) => OY + m * PPM;
    function bounds() {
      let maxX = 0, maxY = 0;
      geom.walls.forEach((w) => { maxX = Math.max(maxX, w.x1, w.x2); maxY = Math.max(maxY, w.y1, w.y2); });
      return { maxX, maxY };
    }
    let VW = 1000, VH = 1000;

    // ---------- helpers geométricos ----------
    const isH = (w) => Math.abs(w.y1 - w.y2) < 1e-6;
    const isV = (w) => Math.abs(w.x1 - w.x2) < 1e-6;
    const wallLen = (w) => Math.hypot(w.x2 - w.x1, w.y2 - w.y1);

    // divide un muro en blocks (40 cm + junta 1 cm); el último se ajusta al sobrante
    function wallBlocks(w) {
      const horizontal = isH(w);
      const lo = horizontal ? Math.min(w.x1, w.x2) : Math.min(w.y1, w.y2);
      const hi = horizontal ? Math.max(w.x1, w.x2) : Math.max(w.y1, w.y2);
      const fixed = horizontal ? w.y1 : w.x1;
      const BL = geom.blockLen || DEF_BLOCK_LEN, JT = geom.joint != null ? geom.joint : DEF_JOINT;
      const blocks = [];
      let s = lo, idx = 0;
      while (s < hi - 0.02) {
        const e = Math.min(s + BL, hi);
        blocks.push({ idx, s, e, fixed, horizontal });
        s = e + JT; idx++;
      }
      return blocks;
    }

    // huella (shoelace sobre muros 'ext' en orden)
    function footprintArea() {
      const ext = geom.walls.filter((w) => w.type === 'ext');
      if (ext.length < 3) return 0;
      const pts = ext.map((w) => [w.x1, w.y1]);
      let a = 0;
      for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
        a += x1 * y2 - x2 * y1;
      }
      return Math.abs(a) / 2;
    }

    // ---------- coordenadas pantalla -> usuario svg -> metros ----------
    let svgEl = null;
    function clientToM(clientX, clientY) {
      const pt = svgEl.createSVGPoint();
      pt.x = clientX; pt.y = clientY;
      const inv = svgEl.getScreenCTM().inverse();
      const u = pt.matrixTransform(inv);
      return { x: (u.x - OX) / PPM, y: (u.y - OY) / PPM };
    }

    // ---------- vista (zoom + desplazamiento) ----------
    function currentVB() { return vb ? vb : { x: 0, y: 0, w: VW, h: VH }; }
    function clampVB() {
      if (!vb) return;
      if (vb.w >= VW || vb.h >= VH) { vb = null; return; }     // si abarca todo, vuelve a "Ajustar"
      vb.x = Math.max(0, Math.min(vb.x, VW - vb.w));
      vb.y = Math.max(0, Math.min(vb.y, VH - vb.h));
    }
    function applyVB() {
      if (!svgEl) return;
      clampVB();
      const v = currentVB();
      svgEl.setAttribute('viewBox', v.x + ' ' + v.y + ' ' + v.w + ' ' + v.h);
      svgEl.setAttribute('width', v.w);
      svgEl.setAttribute('height', v.h);
    }
    function zoomTo(ux, uy, factor) {
      const v = currentVB();
      let nw = v.w / factor, nh = v.h / factor;
      const minW = VW * 0.12;                                   // tope de acercamiento (~8x)
      if (nw < minW) { const r = minW / nw; nw *= r; nh *= r; }
      if (nw >= VW || nh >= VH) { vb = null; applyVB(); return; } // 100% del terreno = Ajustar
      vb = { x: ux - (ux - v.x) * (nw / v.w), y: uy - (uy - v.y) * (nh / v.h), w: nw, h: nh };
      applyVB();
    }
    function zoomCenter(factor) { const v = currentVB(); zoomTo(v.x + v.w / 2, v.y + v.h / 2, factor); }
    function onWheel(ev) {
      if (!(ev.ctrlKey || ev.metaKey)) return;                  // zoom solo con Ctrl/⌘ + rueda (deja el scroll normal)
      ev.preventDefault();
      const v = currentVB(), rect = svgEl.getBoundingClientRect();
      const ux = v.x + (ev.clientX - rect.left) / rect.width  * v.w;
      const uy = v.y + (ev.clientY - rect.top)  / rect.height * v.h;
      zoomTo(ux, uy, ev.deltaY < 0 ? 1.15 : 1 / 1.15);
    }
    function startPan(ev) {
      const v = currentVB();
      panning = { x0: ev.clientX, y0: ev.clientY, vx: v.x, vy: v.y, w: v.w, h: v.h, cw: svgEl.clientWidth || 1, ch: svgEl.clientHeight || 1 };
      try { svgEl.setPointerCapture(ev.pointerId); } catch (e) {}
      svgEl.addEventListener('pointermove', onPanMove);
      svgEl.addEventListener('pointerup', endPan);
      svgEl.addEventListener('pointercancel', endPan);
      svgEl.style.cursor = 'grabbing';
    }
    function onPanMove(ev) {
      if (!panning) return;
      const kx = panning.w / panning.cw, ky = panning.h / panning.ch;
      vb = { x: panning.vx - (ev.clientX - panning.x0) * kx, y: panning.vy - (ev.clientY - panning.y0) * ky, w: panning.w, h: panning.h };
      applyVB();
    }
    function endPan() {
      panning = null;
      svgEl.removeEventListener('pointermove', onPanMove);
      svgEl.removeEventListener('pointerup', endPan);
      svgEl.removeEventListener('pointercancel', endPan);
      svgEl.style.cursor = panMode ? 'grab' : '';
    }

    // ============================================================
    //   RENDER
    // ============================================================
    let rafPending = false;
    function render() {                  // coalescer: 1 repintado por frame durante arrastres
      if (rafPending) return;
      rafPending = true;
      (window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(function () { rafPending = false; renderNow(); });
    }
    function renderNow() {
      const T = wallCm / 100, tpx = T * PPM;
      const b = bounds();
      VW = X(b.maxX) + 150;
      VH = Y(b.maxY) + 170;

      let g = '';
      // fondo
      g += el('rect', { x: 0, y: 0, width: VW, height: VH, fill: '#fbfaf8' });

      // retícula 1 m
      let grid = '';
      const gx = Math.ceil(b.maxX), gy = Math.ceil(b.maxY);
      for (let i = 0; i <= gx; i++) grid += el('line', { x1: X(i), y1: Y(0), x2: X(i), y2: Y(b.maxY), stroke: '#e2e0db', 'stroke-width': 0.7 });
      for (let j = 0; j <= gy; j++) grid += el('line', { x1: X(0), y1: Y(j), x2: X(b.maxX), y2: Y(j), stroke: '#e2e0db', 'stroke-width': 0.7 });
      // subreticula de snap
      if (snap > 0 && snap < 1) {
        for (let i = 0; i <= gx / snap; i++) { const m = i * snap; if (Math.abs(m - Math.round(m)) > 1e-6 && m <= b.maxX) grid += el('line', { x1: X(m), y1: Y(0), x2: X(m), y2: Y(b.maxY), stroke: '#eeece8', 'stroke-width': 0.4 }); }
        for (let j = 0; j <= gy / snap; j++) { const m = j * snap; if (Math.abs(m - Math.round(m)) > 1e-6 && m <= b.maxY) grid += el('line', { x1: X(0), y1: Y(m), x2: X(b.maxX), y2: Y(m), stroke: '#eeece8', 'stroke-width': 0.4 }); }
      }
      g += el('g', {}, grid);

      // ====== reglas métricas (tablero) — bandas arriba e izquierda ======
      let ruler = '';
      const rb = '#16181d';
      const topY = OY - 26, leftX = OX - 26;
      // banda superior
      ruler += el('rect', { x: OX, y: topY, width: b.maxX * PPM, height: 18, fill: '#fff', stroke: '#d8d5cd', 'stroke-width': 0.8 });
      ruler += el('rect', { x: leftX, y: OY, width: 18, height: b.maxY * PPM, fill: '#fff', stroke: '#d8d5cd', 'stroke-width': 0.8 });
      // ticks horizontales cada 0.10, etiqueta cada 1.0
      for (let i = 0; i <= Math.round(b.maxX / 0.1); i++) {
        const m = round2(i * 0.1), xx = X(m), whole = Math.abs(m - Math.round(m)) < 1e-6, half = Math.abs((m * 10) % 5) < 1e-6;
        const tl = whole ? 11 : half ? 7 : 4;
        ruler += el('line', { x1: xx, y1: topY + 18, x2: xx, y2: topY + 18 - tl, stroke: rb, 'stroke-width': whole ? 1 : 0.6, opacity: whole ? 0.9 : 0.5 });
        if (whole) ruler += el('text', { x: xx + 2, y: topY + 9, fill: rb, 'font-size': 9, 'font-family': 'var(--fl)', 'font-weight': 600 }, m.toFixed(0));
      }
      for (let j = 0; j <= Math.round(b.maxY / 0.1); j++) {
        const m = round2(j * 0.1), yy = Y(m), whole = Math.abs(m - Math.round(m)) < 1e-6, half = Math.abs((m * 10) % 5) < 1e-6;
        const tl = whole ? 11 : half ? 7 : 4;
        ruler += el('line', { x1: leftX + 18, y1: yy, x2: leftX + 18 - tl, y2: yy, stroke: rb, 'stroke-width': whole ? 1 : 0.6, opacity: whole ? 0.9 : 0.5 });
        if (whole) ruler += el('text', { x: leftX + 9, y: yy - 2, fill: rb, 'font-size': 9, 'font-family': 'var(--fl)', 'font-weight': 600, 'text-anchor': 'middle', transform: `rotate(-90 ${leftX + 9} ${yy - 2})` }, m.toFixed(0));
      }
      // marca de unidad
      ruler += el('text', { x: leftX + 9, y: topY + 9, fill: rb, 'font-size': 7.5, 'font-family': 'var(--fl)', 'text-anchor': 'middle', 'dominant-baseline': 'middle', opacity: 0.6 }, 'm');
      g += el('g', {}, ruler);

      // muros: poché sólido o relleno de blocks
      let walls = '';
      geom.walls.forEach((w) => {
        const isSel = sel && sel.kind === 'wall' && sel.id === w.id;
        if (blockMode) {
          const re = w.re || [];
          wallBlocks(w).forEach((bk) => {
            const reinf = re.indexOf(bk.idx) >= 0;
            const bx = bk.horizontal ? X(bk.s) : X(bk.fixed) - tpx / 2;
            const by = bk.horizontal ? Y(bk.fixed) - tpx / 2 : Y(bk.s);
            const bw = bk.horizontal ? (bk.e - bk.s) * PPM : tpx;
            const bh = bk.horizontal ? tpx : (bk.e - bk.s) * PPM;
            walls += el('rect', { x: bx, y: by, width: bw, height: bh, fill: reinf ? '#16181d' : '#e7e4dd', stroke: isSel ? '#c75b39' : '#16181d', 'stroke-width': isSel ? 1.4 : 1 });
            if (reinf) {
              // varilla (sección de acero) al centro del block
              const cx = bx + bw / 2, cy = by + bh / 2, rr = Math.min(tpx * 0.22, bw * 0.18, bh * 0.18, 5);
              walls += el('circle', { cx, cy, r: Math.max(2, rr), fill: '#fbfaf8', stroke: '#16181d', 'stroke-width': 0.8 });
            }
          });
        } else {
          walls += el('line', { x1: X(w.x1), y1: Y(w.y1), x2: X(w.x2), y2: Y(w.y2), stroke: isSel ? '#c75b39' : '#16181d', 'stroke-width': tpx, 'stroke-linecap': 'square' });
        }
      });
      g += walls;

      // recortes (ventanas + puertas) en color papel
      let cuts = '';
      const cutSeg = (wall, fixed, a, b2) => {
        if (wall === 'h') cuts += el('rect', { x: X(a), y: Y(fixed) - tpx / 2 - 1, width: (b2 - a) * PPM, height: tpx + 2, fill: '#fbfaf8' });
        else cuts += el('rect', { x: X(fixed) - tpx / 2 - 1, y: Y(a), width: tpx + 2, height: (b2 - a) * PPM, fill: '#fbfaf8' });
      };
      geom.windows.forEach((wn) => cutSeg(wn.wall, wn.fixed, wn.a, wn.b));
      geom.sliders.forEach((s) => cutSeg(s.wall, s.fixed, s.a, s.b));
      geom.doors.forEach((d) => {
        if (d.wall === 'h') { const x0 = Math.min(d.hx, d.hx + d.along[0] * d.w); cutSeg('h', d.hy, x0, x0 + d.w); }
        else { const y0 = Math.min(d.hy, d.hy + d.along[1] * d.w); cutSeg('v', d.hx, y0, y0 + d.w); }
      });
      g += cuts;

      // ventanas (vidrio)
      let win = '';
      geom.windows.forEach((wn) => {
        const isSel = sel && sel.kind === 'window' && sel.id === wn.id;
        const col = isSel ? '#c75b39' : '#16181d';
        if (wn.wall === 'h') {
          const y = Y(wn.fixed);
          [-tpx / 2, 0, tpx / 2].forEach((o) => win += el('line', { x1: X(wn.a), y1: y + o, x2: X(wn.b), y2: y + o, stroke: col, 'stroke-width': 1.4 }));
          win += el('line', { x1: X(wn.a), y1: y - tpx / 2, x2: X(wn.a), y2: y + tpx / 2, stroke: col, 'stroke-width': 1.4 });
          win += el('line', { x1: X(wn.b), y1: y - tpx / 2, x2: X(wn.b), y2: y + tpx / 2, stroke: col, 'stroke-width': 1.4 });
        } else {
          const x = X(wn.fixed);
          [-tpx / 2, 0, tpx / 2].forEach((o) => win += el('line', { x1: x + o, y1: Y(wn.a), x2: x + o, y2: Y(wn.b), stroke: col, 'stroke-width': 1.4 }));
          win += el('line', { x1: x - tpx / 2, y1: Y(wn.a), x2: x + tpx / 2, y2: Y(wn.a), stroke: col, 'stroke-width': 1.4 });
          win += el('line', { x1: x - tpx / 2, y1: Y(wn.b), x2: x + tpx / 2, y2: Y(wn.b), stroke: col, 'stroke-width': 1.4 });
        }
      });
      g += win;

      // puertas corredizas (2 paneles traslapados)
      let sld = '';
      geom.sliders.forEach((s) => {
        const isSel = sel && sel.kind === 'slider' && sel.id === s.id;
        const col = isSel ? '#c75b39' : '#16181d';
        const sw = 1.4, gap = tpx * 0.22;
        if (s.wall === 'v') {
          const x = X(s.fixed), mid = (s.a + s.b) / 2;
          sld += el('line', { x1: x - tpx / 2, y1: Y(s.a), x2: x + tpx / 2, y2: Y(s.a), stroke: col, 'stroke-width': sw });
          sld += el('line', { x1: x - tpx / 2, y1: Y(s.b), x2: x + tpx / 2, y2: Y(s.b), stroke: col, 'stroke-width': sw });
          sld += el('rect', { x: x - gap - 1.2, y: Y(s.a) + 1, width: 2.4, height: (mid - s.a) * PPM + 2, fill: 'none', stroke: col, 'stroke-width': sw });
          sld += el('rect', { x: x + gap - 1.2, y: Y(mid) - 1, width: 2.4, height: (s.b - mid) * PPM + 2, fill: 'none', stroke: col, 'stroke-width': sw });
        } else {
          const y = Y(s.fixed), mid = (s.a + s.b) / 2;
          sld += el('line', { x1: X(s.a), y1: y - tpx / 2, x2: X(s.a), y2: y + tpx / 2, stroke: col, 'stroke-width': sw });
          sld += el('line', { x1: X(s.b), y1: y - tpx / 2, x2: X(s.b), y2: y + tpx / 2, stroke: col, 'stroke-width': sw });
          sld += el('rect', { x: X(s.a) + 1, y: y - gap - 1.2, width: (mid - s.a) * PPM + 2, height: 2.4, fill: 'none', stroke: col, 'stroke-width': sw });
          sld += el('rect', { x: X(mid) - 1, y: y + gap - 1.2, width: (s.b - mid) * PPM + 2, height: 2.4, fill: 'none', stroke: col, 'stroke-width': sw });
        }
      });
      g += sld;

      // puertas (hoja + barrido convexo)
      let doors = '';
      geom.doors.forEach((d) => {
        const isSel = sel && sel.kind === 'door' && sel.id === d.id;
        const col = isSel ? '#c75b39' : '#16181d';
        const wpx = d.w * PPM, hX = X(d.hx), hY = Y(d.hy);
        const aTipX = hX + d.along[0] * wpx, aTipY = hY + d.along[1] * wpx;
        const oTipX = hX + d.open[0] * wpx, oTipY = hY + d.open[1] * wpx;
        doors += el('line', { x1: hX, y1: hY, x2: oTipX, y2: oTipY, stroke: col, 'stroke-width': 2 });
        const cross = d.along[0] * d.open[1] - d.along[1] * d.open[0];
        const sweep = cross > 0 ? 0 : 1;
        doors += el('path', { d: `M ${oTipX} ${oTipY} A ${wpx} ${wpx} 0 0 ${sweep} ${aTipX} ${aTipY}`, fill: 'none', stroke: col, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.8 });
      });
      g += doors;

      // ====== mobiliario ======
      let furn = '';
      const FL = (window.PlanFurniture || null);
      geom.furniture.forEach((f) => {
        const isSel = sel && sel.kind === 'furn' && sel.id === f.id;
        const col = isSel ? '#c75b39' : '#3a3a3a';
        const cx = X(f.cx), cy = Y(f.cy), wpx = f.w * PPM, hpx = f.h * PPM;
        const sym = FL ? FL.draw(f.type, wpx, hpx, col, isSel ? 1.6 : 1.2) : '';
        furn += el('g', { transform: `translate(${cx} ${cy}) rotate(${f.rot || 0})` }, sym);
      });
      g += el('g', { opacity: 0.95 }, furn);

      // ====== etiquetas de espacio (Recámara, Cocina…) ======
      let labs = '';
      (geom.labels || []).forEach((l) => {
        const isSel = sel && sel.kind === 'label' && sel.id === l.id;
        const tx = X(l.cx), ty = Y(l.cy);
        const w = Math.max(28, esc(l.text).length * 8 + 16);
        labs += el('rect', { x: tx - w / 2, y: ty - 11, width: w, height: 22, rx: 4, fill: '#fff', stroke: isSel ? '#c75b39' : '#c9c4ba', 'stroke-width': isSel ? 1.5 : 0.8, opacity: 0.92 });
        labs += el('text', { x: tx, y: ty + 4, 'text-anchor': 'middle', fill: isSel ? '#c75b39' : '#3a3a3a', 'font-size': 12, 'font-family': 'var(--fl)', 'font-weight': 600 }, esc(l.text) || '—');
      });
      g += el('g', {}, labs);

      // longitudes de muro
      if (showLen) {
        let lab = '';
        geom.walls.forEach((w) => {
          const L = wallLen(w); if (L < 0.05) return;
          const mx = (X(w.x1) + X(w.x2)) / 2, my = (Y(w.y1) + Y(w.y2)) / 2;
          const vert = isV(w);
          const tx = vert ? mx - 9 : mx, ty = vert ? my : my - 8;
          const isSel = sel && sel.kind === 'wall' && sel.id === w.id;
          lab += el('text', Object.assign({ x: tx, y: ty, 'text-anchor': 'middle', fill: isSel ? '#c75b39' : '#6b6256', 'font-size': isSel ? 13 : 11, 'font-family': 'var(--fl)', 'font-weight': isSel ? 700 : 500 }, vert ? { transform: `rotate(-90 ${tx} ${ty})` } : {}), fmt(L));
        });
        g += el('g', {}, lab);
      }

      // cotas globales (huella bbox)
      const ink = '#16181d';
      let dims = '';
      const dyB = OY - 64;
      dims += el('line', { x1: X(0), y1: dyB, x2: X(b.maxX), y2: dyB, stroke: ink, 'stroke-width': 0.9 });
      [X(0), X(b.maxX)].forEach((xx) => dims += el('line', { x1: xx - 4, y1: dyB + 4, x2: xx + 4, y2: dyB - 4, stroke: ink, 'stroke-width': 1.1 }));
      dims += el('text', { x: (X(0) + X(b.maxX)) / 2, y: dyB - 6, 'text-anchor': 'middle', fill: ink, 'font-size': 13, 'font-family': 'var(--fl)', 'font-weight': 600 }, fmt(b.maxX));
      const dxB = OX - 70;
      dims += el('line', { x1: dxB, y1: Y(0), x2: dxB, y2: Y(b.maxY), stroke: ink, 'stroke-width': 0.9 });
      [Y(0), Y(b.maxY)].forEach((yy) => dims += el('line', { x1: dxB - 4, y1: yy + 4, x2: dxB + 4, y2: yy - 4, stroke: ink, 'stroke-width': 1.1 }));
      dims += el('text', { x: dxB - 6, y: (Y(0) + Y(b.maxY)) / 2, 'text-anchor': 'middle', fill: ink, 'font-size': 13, 'font-family': 'var(--fl)', 'font-weight': 600, transform: `rotate(-90 ${dxB - 6} ${(Y(0) + Y(b.maxY)) / 2})` }, fmt(b.maxY));
      g += el('g', {}, dims);

      // ====== capa de manijas interactivas ======
      let hit = '';
      // muros: cuerpo + extremos (o blocks clicables en modo block)
      geom.walls.forEach((w) => {
        const isSel = sel && sel.kind === 'wall' && sel.id === w.id;
        if (blockMode) {
          wallBlocks(w).forEach((bk) => {
            const bx = bk.horizontal ? X(bk.s) : X(bk.fixed) - tpx / 2;
            const by = bk.horizontal ? Y(bk.fixed) - tpx / 2 : Y(bk.s);
            const bw = bk.horizontal ? (bk.e - bk.s) * PPM : tpx;
            const bh = bk.horizontal ? tpx : (bk.e - bk.s) * PPM;
            hit += el('rect', { x: bx, y: by, width: Math.max(bw, 6), height: Math.max(bh, 6), fill: 'transparent', 'data-kind': 'block', 'data-id': w.id, 'data-idx': bk.idx, style: 'cursor:pointer' });
          });
        } else {
          hit += el('line', { x1: X(w.x1), y1: Y(w.y1), x2: X(w.x2), y2: Y(w.y2), stroke: 'transparent', 'stroke-width': Math.max(tpx, 16), 'stroke-linecap': 'round', 'data-kind': 'wall', 'data-id': w.id, 'data-part': 'body', style: 'cursor:move' });
        }
        if (isSel) {
          [['p1', w.x1, w.y1], ['p2', w.x2, w.y2]].forEach(([p, mx, my]) => {
            hit += el('circle', { cx: X(mx), cy: Y(my), r: 10, fill: '#fff', stroke: '#c75b39', 'stroke-width': 2, 'data-kind': 'wall', 'data-id': w.id, 'data-part': p, style: 'cursor:crosshair' });
          });
        }
      });
      // ventanas: cuerpo + extremos a/b
      geom.windows.forEach((wn) => {
        const isSel = sel && sel.kind === 'window' && sel.id === wn.id;
        if (wn.wall === 'h') {
          hit += el('rect', { x: X(wn.a), y: Y(wn.fixed) - 9, width: (wn.b - wn.a) * PPM, height: 18, fill: 'transparent', 'data-kind': 'window', 'data-id': wn.id, 'data-part': 'body', style: 'cursor:move' });
          if (isSel) { hit += el('circle', { cx: X(wn.a), cy: Y(wn.fixed), r: 9, fill: '#fff', stroke: '#c75b39', 'stroke-width': 2, 'data-kind': 'window', 'data-id': wn.id, 'data-part': 'a', style: 'cursor:ew-resize' }); hit += el('circle', { cx: X(wn.b), cy: Y(wn.fixed), r: 9, fill: '#fff', stroke: '#c75b39', 'stroke-width': 2, 'data-kind': 'window', 'data-id': wn.id, 'data-part': 'b', style: 'cursor:ew-resize' }); }
        } else {
          hit += el('rect', { x: X(wn.fixed) - 9, y: Y(wn.a), width: 18, height: (wn.b - wn.a) * PPM, fill: 'transparent', 'data-kind': 'window', 'data-id': wn.id, 'data-part': 'body', style: 'cursor:move' });
          if (isSel) { hit += el('circle', { cx: X(wn.fixed), cy: Y(wn.a), r: 9, fill: '#fff', stroke: '#c75b39', 'stroke-width': 2, 'data-kind': 'window', 'data-id': wn.id, 'data-part': 'a', style: 'cursor:ns-resize' }); hit += el('circle', { cx: X(wn.fixed), cy: Y(wn.b), r: 9, fill: '#fff', stroke: '#c75b39', 'stroke-width': 2, 'data-kind': 'window', 'data-id': wn.id, 'data-part': 'b', style: 'cursor:ns-resize' }); }
        }
      });
      // puertas corredizas: cuerpo + extremos a/b (igual que ventanas)
      geom.sliders.forEach((s) => {
        const isSel = sel && sel.kind === 'slider' && sel.id === s.id;
        if (s.wall === 'h') {
          hit += el('rect', { x: X(s.a), y: Y(s.fixed) - 9, width: (s.b - s.a) * PPM, height: 18, fill: 'transparent', 'data-kind': 'slider', 'data-id': s.id, 'data-part': 'body', style: 'cursor:move' });
          if (isSel) { hit += el('circle', { cx: X(s.a), cy: Y(s.fixed), r: 9, fill: '#fff', stroke: '#c75b39', 'stroke-width': 2, 'data-kind': 'slider', 'data-id': s.id, 'data-part': 'a', style: 'cursor:ew-resize' }); hit += el('circle', { cx: X(s.b), cy: Y(s.fixed), r: 9, fill: '#fff', stroke: '#c75b39', 'stroke-width': 2, 'data-kind': 'slider', 'data-id': s.id, 'data-part': 'b', style: 'cursor:ew-resize' }); }
        } else {
          hit += el('rect', { x: X(s.fixed) - 9, y: Y(s.a), width: 18, height: (s.b - s.a) * PPM, fill: 'transparent', 'data-kind': 'slider', 'data-id': s.id, 'data-part': 'body', style: 'cursor:move' });
          if (isSel) { hit += el('circle', { cx: X(s.fixed), cy: Y(s.a), r: 9, fill: '#fff', stroke: '#c75b39', 'stroke-width': 2, 'data-kind': 'slider', 'data-id': s.id, 'data-part': 'a', style: 'cursor:ns-resize' }); hit += el('circle', { cx: X(s.fixed), cy: Y(s.b), r: 9, fill: '#fff', stroke: '#c75b39', 'stroke-width': 2, 'data-kind': 'slider', 'data-id': s.id, 'data-part': 'b', style: 'cursor:ns-resize' }); }
        }
      });
      // puertas: cuerpo + manija de ancho (jamba opuesta a la bisagra)
      geom.doors.forEach((d) => {
        const isSel = sel && sel.kind === 'door' && sel.id === d.id;
        if (d.wall === 'h') { const x0 = Math.min(d.hx, d.hx + d.along[0] * d.w); hit += el('rect', { x: X(x0), y: Y(d.hy) - 9, width: d.w * PPM, height: 18, fill: 'transparent', 'data-kind': 'door', 'data-id': d.id, 'data-part': 'body', style: 'cursor:move' }); }
        else { const y0 = Math.min(d.hy, d.hy + d.along[1] * d.w); hit += el('rect', { x: X(d.hx) - 9, y: Y(y0), width: 18, height: d.w * PPM, fill: 'transparent', 'data-kind': 'door', 'data-id': d.id, 'data-part': 'body', style: 'cursor:move' }); }
        if (isSel) {
          const ex = X(d.hx + d.along[0] * d.w), ey = Y(d.hy + d.along[1] * d.w);
          hit += el('circle', { cx: ex, cy: ey, r: 9, fill: '#fff', stroke: '#c75b39', 'stroke-width': 2, 'data-kind': 'door', 'data-id': d.id, 'data-part': 'w', style: 'cursor:crosshair' });
        }
      });
      // mobiliario: cuerpo (rota con la pieza) + manijas girar/escalar
      geom.furniture.forEach((f) => {
        const isSel = sel && sel.kind === 'furn' && sel.id === f.id;
        const cx = X(f.cx), cy = Y(f.cy), wpx = f.w * PPM, hpx = f.h * PPM;
        let gh = el('rect', { x: -wpx / 2, y: -hpx / 2, width: wpx, height: hpx, fill: 'transparent', 'data-kind': 'furn', 'data-id': f.id, 'data-part': 'body', style: 'cursor:move' });
        if (isSel) {
          gh += el('rect', { x: -wpx / 2, y: -hpx / 2, width: wpx, height: hpx, fill: 'none', stroke: '#c75b39', 'stroke-width': 1, 'stroke-dasharray': '4 3', opacity: 0.8 });
          // escalar: esquina inf-derecha (local)
          gh += el('circle', { cx: wpx / 2, cy: hpx / 2, r: 9, fill: '#fff', stroke: '#c75b39', 'stroke-width': 2, 'data-kind': 'furn', 'data-id': f.id, 'data-part': 'scale', style: 'cursor:nwse-resize' });
          // girar: arriba al centro
          gh += el('line', { x1: 0, y1: -hpx / 2, x2: 0, y2: -hpx / 2 - 18, stroke: '#c75b39', 'stroke-width': 1.4 });
          gh += el('circle', { cx: 0, cy: -hpx / 2 - 22, r: 9, fill: '#fff', stroke: '#c75b39', 'stroke-width': 2, 'data-kind': 'furn', 'data-id': f.id, 'data-part': 'rotate', style: 'cursor:grab' });
        }
        hit += el('g', { transform: `translate(${cx} ${cy}) rotate(${f.rot || 0})` }, gh);
      });
      (geom.labels || []).forEach((l) => {
        const tx = X(l.cx), ty = Y(l.cy);
        const w = Math.max(28, esc(l.text).length * 8 + 16);
        hit += el('rect', { x: tx - w / 2, y: ty - 12, width: w, height: 24, fill: 'transparent', 'data-kind': 'label', 'data-id': l.id, 'data-part': 'body', style: 'cursor:move' });
      });
      g += el('g', {}, hit);

      // svg persistente: solo actualizamos su contenido (no recrear el nodo,
      // para no perder la captura del puntero durante el arrastre)
      ensureSvg();
      applyVB();                      // respeta el zoom/posición actual (o ajusta si vb=null)
      svgEl.innerHTML = g;
      updateInfo();
    }

    function ensureSvg() {
      if (svgEl && svgEl.isConnected) return;
      const holder = document.createElement('div');
      holder.innerHTML = '<svg id="' + mountId + '_svg" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block;touch-action:none;font-family:var(--fl)"></svg>';
      svgEl = holder.firstChild;
      root.innerHTML = '';
      root.appendChild(svgEl);
      svgEl.addEventListener('pointerdown', onDown);
      svgEl.addEventListener('pointermove', onAnyMove);
      svgEl.addEventListener('pointerup', onAnyUp);
      svgEl.addEventListener('pointercancel', onAnyUp);
      svgEl.addEventListener('wheel', onWheel, { passive: false });
    }

    // ============================================================
    //   INTERACCIÓN
    // ============================================================
    let drag = null;
    function ptrDist() { const a = [...ptrs.values()]; return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); }
    function ptrMid() { const a = [...ptrs.values()]; return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 }; }
    function userAt(cx, cy) { const v = currentVB(), r = svgEl.getBoundingClientRect(); return { x: v.x + (cx - r.left) / r.width * v.w, y: v.y + (cy - r.top) / r.height * v.h }; }
    function startPinch() {
      if (drag) { drag = null; svgEl.removeEventListener('pointermove', onMove); svgEl.removeEventListener('pointerup', onUp); }
      if (panning) endPan();
      pinch = { dist: ptrDist(), mid: ptrMid() };
    }
    function movePinch() {
      if (ptrs.size < 2) return;
      const d = ptrDist(), mid = ptrMid();
      if (pinch.dist > 0) { const u = userAt(mid.x, mid.y); zoomTo(u.x, u.y, d / pinch.dist); }
      const v = currentVB(), r = svgEl.getBoundingClientRect();
      if (vb) { vb.x -= (mid.x - pinch.mid.x) / r.width * v.w; vb.y -= (mid.y - pinch.mid.y) / r.height * v.h; applyVB(); }
      pinch.dist = d; pinch.mid = mid;
    }
    function endPinch() { pinch = null; }
    function onAnyMove(ev) { if (ptrs.has(ev.pointerId)) ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY }); if (pinch) { movePinch(); ev.preventDefault(); } }
    function onAnyUp(ev) { ptrs.delete(ev.pointerId); if (pinch && ptrs.size < 2) endPinch(); }
    function onDown(ev) {
      if (ev.button != null && ev.button !== 0 && ev.pointerType === 'mouse') return;   // solo botón izquierdo del ratón
      ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (ptrs.size >= 2) { startPinch(); ev.preventDefault(); return; }
      // desplazar la vista (modo Mover o barra Espaciadora) — no edita nada
      if (panMode || spaceDown) { startPan(ev); ev.preventDefault(); return; }
      // modo colocación de MUEBLE: clic en cualquier punto del lienzo
      if (placing && placing.indexOf('furn:') === 0) {
        const type = placing.slice(5);
        const m = clientToM(ev.clientX, ev.clientY);
        placeFurniture(type, m);
        placing = null; svgEl.style.cursor = ''; render();
        ev.preventDefault(); return;
      }
      if (placing && placing.indexOf('label:') === 0) {
        const text = placing.slice(6);
        placeLabel(text, clientToM(ev.clientX, ev.clientY));
        placing = null; svgEl.style.cursor = ''; render();
        ev.preventDefault(); return;
      }
      // modo colocación de VANO: clic en muro o block coloca el elemento
      if (placing && placing !== 'wall') {
        const wt = ev.target.closest('[data-kind="wall"], [data-kind="block"]');
        const w = wt ? find('wall', wt.getAttribute('data-id')) : null;
        if (w) placeOnWall(placing, w, clientToM(ev.clientX, ev.clientY));
        placing = null; svgEl.style.cursor = ''; render();
        ev.preventDefault(); return;
      }
      // modo dibujar MURO: arrastra de inicio a fin
      if (placing === 'wall') {
        pushHistory();
        const m = clientToM(ev.clientX, ev.clientY);
        const sx = snapV(m.x), sy = snapV(m.y);
        const w = { id: nid('w'), type: 'int', x1: sx, y1: sy, x2: sx, y2: sy, re: [] };
        geom.walls.push(w); sel = { kind: 'wall', id: w.id };
        placing = null; svgEl.style.cursor = '';
        drag = { kind: 'drawwall', id: w.id, m0: m, pointerId: ev.pointerId };
        try { svgEl.setPointerCapture(ev.pointerId); } catch (e) {}
        svgEl.addEventListener('pointermove', onMove);
        svgEl.addEventListener('pointerup', onUp);
        svgEl.addEventListener('pointercancel', onUp);
        render(); ev.preventDefault(); return;
      }
      const t = ev.target.closest('[data-kind]');
      if (!t) { sel = null; render(); return; }
      let kind = t.getAttribute('data-kind'), id = t.getAttribute('data-id'), part = t.getAttribute('data-part');
      let blockToggle = null;
      if (kind === 'block') { blockToggle = { wallId: id, idx: +t.getAttribute('data-idx') }; kind = 'wall'; part = 'body'; }
      const obj = find(kind, id);
      if (!obj) return;
      sel = { kind, id };
      pushHistory();
      const m0 = clientToM(ev.clientX, ev.clientY);
      drag = { kind, id, part, m0, orig: JSON.parse(JSON.stringify(obj)), blockToggle, moved: false, pointerId: ev.pointerId };
      try { svgEl.setPointerCapture(ev.pointerId); } catch (e) {}
      svgEl.addEventListener('pointermove', onMove);
      svgEl.addEventListener('pointerup', onUp);
      svgEl.addEventListener('pointercancel', onUp);
      render();
      ev.preventDefault();
    }
    function find(kind, id) {
      const arr = kind === 'wall' ? geom.walls : kind === 'window' ? geom.windows : kind === 'slider' ? geom.sliders : kind === 'furn' ? geom.furniture : kind === 'label' ? geom.labels : geom.doors;
      return arr.find((o) => o.id === id);
    }
    // colocar mueble en el punto m (metros), centrado
    function placeFurniture(type, m) {
      const cat = (window.PlanFurniture && window.PlanFurniture.CATALOG[type]) || { w: 1, h: 1 };
      pushHistory();
      const f = { id: nid('f'), type, cx: snapV(m.x), cy: snapV(m.y), w: cat.w, h: cat.h, rot: 0 };
      geom.furniture.push(f); sel = { kind: 'furn', id: f.id };
      save();
    }
    function placeLabel(text, m) {
      pushHistory();
      const l = { id: nid('t'), cx: snapV(m.x), cy: snapV(m.y), text: String(text || 'Espacio').slice(0, 40) };
      geom.labels.push(l); sel = { kind: 'label', id: l.id };
      save();
    }
    // colocar ventana/puerta/corrediza sobre un muro en el punto m (metros)
    function placeOnWall(type, w, m) {
      if (!w) return;
      pushHistory();
      const horizontal = isH(w);
      const tag = horizontal ? 'h' : 'v';
      const fixed = horizontal ? w.y1 : w.x1;
      const lo = horizontal ? Math.min(w.x1, w.x2) : Math.min(w.y1, w.y2);
      const hi = horizontal ? Math.max(w.x1, w.x2) : Math.max(w.y1, w.y2);
      const click = horizontal ? m.x : m.y;
      if (type === 'door') {
        const wd = 0.80;
        let start = snapV(clamp(click - wd / 2, lo, hi - wd));
        const along = horizontal ? [1, 0] : [0, 1];
        const open = horizontal ? [0, 1] : [1, 0];
        const d = { id: nid('d'), wall: tag, hx: horizontal ? start : fixed, hy: horizontal ? fixed : start, w: wd, along, open };
        geom.doors.push(d); sel = { kind: 'door', id: d.id };
      } else {
        const wd = type === 'slider' ? 1.50 : 1.10;
        let a = snapV(clamp(click - wd / 2, lo, hi - wd));
        const o = { id: nid(type === 'slider' ? 's' : 'v'), wall: tag, fixed, a, b: round2(a + wd) };
        (type === 'slider' ? geom.sliders : geom.windows).push(o);
        sel = { kind: type, id: o.id };
      }
      save();
    }
    function onMove(ev) {
      if (!drag) return;
      if (drag.pointerId != null && ev.pointerId !== drag.pointerId) return;   // ignora el 2º dedo
      const m = clientToM(ev.clientX, ev.clientY);
      const dx = m.x - drag.m0.x, dy = m.y - drag.m0.y;

      // dibujo de muro nuevo: extremo ortogonal
      if (drag.kind === 'drawwall') {
        const w = find('wall', drag.id);
        const ex = snapV(m.x), ey = snapV(m.y);
        if (Math.abs(ex - w.x1) >= Math.abs(ey - w.y1)) { w.x2 = ex; w.y2 = w.y1; }
        else { w.y2 = ey; w.x2 = w.x1; }
        render(); ev.preventDefault(); return;
      }

      // umbral clic vs arrastre (para diferenciar reforzar block de mover muro)
      if (!drag.moved && Math.hypot(dx, dy) > 0.04) drag.moved = true;
      if (drag.blockToggle && !drag.moved) { ev.preventDefault(); return; }

      const o = drag.orig, obj = find(drag.kind, drag.id);
      if (drag.kind === 'wall') {
        if (drag.part === 'body') {
          if (isV(o)) { const nx = snapV(o.x1 + dx); obj.x1 = nx; obj.x2 = nx; }
          else if (isH(o)) { const ny = snapV(o.y1 + dy); obj.y1 = ny; obj.y2 = ny; }
          else { obj.x1 = snapV(o.x1 + dx); obj.y1 = snapV(o.y1 + dy); obj.x2 = snapV(o.x2 + dx); obj.y2 = snapV(o.y2 + dy); }
        } else {
          const px = drag.part === 'p1' ? 'x1' : 'x2', py = drag.part === 'p1' ? 'y1' : 'y2';
          obj[px] = snapV(o[px] + dx); obj[py] = snapV(o[py] + dy);
        }
      } else if (drag.kind === 'window' || drag.kind === 'slider') {
        const along = obj.wall === 'h' ? dx : dy;
        if (drag.part === 'body') { const len = o.b - o.a; let na = snapV(o.a + along); obj.a = na; obj.b = round2(na + len); }
        else if (drag.part === 'a') { obj.a = Math.min(snapV(o.a + along), round2(obj.b - 0.2)); }
        else if (drag.part === 'b') { obj.b = Math.max(snapV(o.b + along), round2(obj.a + 0.2)); }
      } else if (drag.kind === 'door') {
        if (drag.part === 'w') {
          const dAlong = (m.x - o.hx) * o.along[0] + (m.y - o.hy) * o.along[1];
          obj.w = Math.max(0.40, snapV(dAlong));
        } else if (obj.wall === 'h') obj.hx = snapV(o.hx + dx);
        else obj.hy = snapV(o.hy + dy);
      } else if (drag.kind === 'label') {
        obj.cx = snapV(o.cx + dx); obj.cy = snapV(o.cy + dy);
      } else if (drag.kind === 'furn') {
        if (drag.part === 'body') {
          obj.cx = snapV(o.cx + dx); obj.cy = snapV(o.cy + dy);
        } else if (drag.part === 'scale') {
          // vector centro→puntero en marco local (deshaciendo rotación)
          const ang = -(o.rot || 0) * Math.PI / 180;
          const vx = m.x - o.cx, vy = m.y - o.cy;
          const lx = vx * Math.cos(ang) - vy * Math.sin(ang);
          const ly = vx * Math.sin(ang) + vy * Math.cos(ang);
          obj.w = Math.max(0.20, snapV(Math.abs(lx) * 2));
          obj.h = Math.max(0.20, snapV(Math.abs(ly) * 2));
        } else if (drag.part === 'rotate') {
          const ang = Math.atan2(m.y - o.cy, m.x - o.cx) * 180 / Math.PI + 90;
          let r = Math.round(ang / 15) * 15; // pasos de 15°
          obj.rot = ((r % 360) + 360) % 360;
        }
      }
      render();
      ev.preventDefault();
    }
    function onUp(ev) {
      if (drag && drag.kind === 'drawwall') {
        const w = find('wall', drag.id);
        if (w && wallLen(w) < 0.10) { geom.walls = geom.walls.filter((x) => x.id !== w.id); sel = null; }
      } else if (drag && drag.blockToggle && !drag.moved) {
        const w = find('wall', drag.blockToggle.wallId);
        if (w) { w.re = w.re || []; const i = w.re.indexOf(drag.blockToggle.idx); if (i >= 0) w.re.splice(i, 1); else w.re.push(drag.blockToggle.idx); }
      }
      drag = null;
      svgEl.removeEventListener('pointermove', onMove);
      svgEl.removeEventListener('pointerup', onUp);
      svgEl.removeEventListener('pointercancel', onUp);
      save();
      render();
    }

    // teclas: flechas mueven selección por 1 paso de snap; Supr borra ventana/puerta
    function isTyping(ev) {
      const t = ev.target;
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    }
    function onKey(ev) {
      if (isTyping(ev)) return;                       // no atajos mientras se escribe en un campo
      if (ev.key === 'Escape') { if (placing) { placing = null; if (svgEl) svgEl.style.cursor = ''; render(); ev.preventDefault(); } return; }
      if ((ev.key === 'z' || ev.key === 'Z') && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); if (ev.shiftKey) redoAct(); else undo(); return; }
      if (ev.key === ' ') { if (!spaceDown) { spaceDown = true; if (svgEl) svgEl.style.cursor = 'grab'; } ev.preventDefault(); return; }
      if (!sel) return;
      const step = snap > 0 ? snap : 0.05;
      const obj = find(sel.kind, sel.id);
      if (!obj) return;
      let used = true;
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (sel.kind === 'window') { pushHistory(); geom.windows = geom.windows.filter((o) => o.id !== sel.id); sel = null; }
        else if (sel.kind === 'slider') { pushHistory(); geom.sliders = geom.sliders.filter((o) => o.id !== sel.id); sel = null; }
        else if (sel.kind === 'door') { pushHistory(); geom.doors = geom.doors.filter((o) => o.id !== sel.id); sel = null; }
        else if (sel.kind === 'wall') { pushHistory(); geom.walls = geom.walls.filter((o) => o.id !== sel.id); sel = null; }
        else if (sel.kind === 'furn') { pushHistory(); geom.furniture = geom.furniture.filter((o) => o.id !== sel.id); sel = null; }
        else if (sel.kind === 'label') { pushHistory(); geom.labels = geom.labels.filter((o) => o.id !== sel.id); sel = null; }
        else used = false;
      } else if (ev.key === 'r' || ev.key === 'R') {
        if (sel.kind === 'furn') { pushHistory(); obj.rot = (((obj.rot || 0) + 90) % 360); }
        else used = false;
      } else if (ev.key.startsWith('Arrow')) {
        pushHistory();
        const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
        const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
        if (sel.kind === 'wall') { obj.x1 = round2(obj.x1 + dx); obj.x2 = round2(obj.x2 + dx); obj.y1 = round2(obj.y1 + dy); obj.y2 = round2(obj.y2 + dy); }
        else if (sel.kind === 'window' || sel.kind === 'slider') { if (obj.wall === 'h') { obj.a = round2(obj.a + dx); obj.b = round2(obj.b + dx); } else { obj.a = round2(obj.a + dy); obj.b = round2(obj.b + dy); } }
        else if (sel.kind === 'door') { if (obj.wall === 'h') obj.hx = round2(obj.hx + dx); else obj.hy = round2(obj.hy + dy); }
        else if (sel.kind === 'furn') { obj.cx = round2(obj.cx + dx); obj.cy = round2(obj.cy + dy); }
      } else used = false;
      if (used) { save(); render(); ev.preventDefault(); }
    }
    function onKeyUp(ev) {
      if (ev.key === ' ') { spaceDown = false; if (svgEl && !panMode && !panning) svgEl.style.cursor = ''; }
    }

    // ---- acciones de selección ----
    function flipHinge() { const o = find('door', sel && sel.id); if (!o) return; pushHistory(); o.hx += o.along[0] * o.w; o.hy += o.along[1] * o.w; o.along = [-o.along[0], -o.along[1]]; save(); render(); }
    function flipSwing() { const o = find('door', sel && sel.id); if (!o) return; pushHistory(); o.open = [-o.open[0], -o.open[1]]; save(); render(); }
    function delSel() { if (!sel) return; if (sel.kind === 'window') { pushHistory(); geom.windows = geom.windows.filter((o) => o.id !== sel.id); } else if (sel.kind === 'slider') { pushHistory(); geom.sliders = geom.sliders.filter((o) => o.id !== sel.id); } else if (sel.kind === 'door') { pushHistory(); geom.doors = geom.doors.filter((o) => o.id !== sel.id); } else if (sel.kind === 'wall') { pushHistory(); geom.walls = geom.walls.filter((o) => o.id !== sel.id); } else if (sel.kind === 'furn') { pushHistory(); geom.furniture = geom.furniture.filter((o) => o.id !== sel.id); } else if (sel.kind === 'label') { pushHistory(); geom.labels = geom.labels.filter((o) => o.id !== sel.id); } sel = null; save(); render(); }

    function rotateSel() { if (!sel || sel.kind !== 'furn') return; const o = find('furn', sel.id); if (!o) return; pushHistory(); o.rot = (((o.rot || 0) + 90) % 360); save(); render(); }

    // ancho +/- (delta en metros). Puertas crecen desde la bisagra; vanos crecen centrados.
    function widen(delta) {
      if (!sel) return; const o = find(sel.kind, sel.id); if (!o) return;
      pushHistory();
      if (sel.kind === 'door') { o.w = Math.max(0.40, round2(o.w + delta)); }
      else { const c = (o.a + o.b) / 2; const half = Math.max(0.20, (o.b - o.a) / 2 + delta / 2); o.a = round2(c - half); o.b = round2(c + half); }
      save(); render();
    }
    function startPlace(type) { placing = type; if (svgEl) svgEl.style.cursor = 'crosshair'; sel = null; render(); }
    // reforzar / liberar todos los blocks del muro seleccionado
    function reinforceAll(flag) {
      if (!sel || sel.kind !== 'wall') return; const w = find('wall', sel.id); if (!w) return;
      pushHistory();
      if (flag) { w.re = wallBlocks(w).map((b) => b.idx); } else { w.re = []; }
      save(); render();
    }

    // ---- exportar resumen legible ----
    function summary() {
      let s = 'CROQUIS — CroKiss · Aurum Arquitectos (medidas en metros)\n';
      s += 'Espesor de muro: ' + wallCm + ' cm\n';
      s += 'Huella (bbox): ' + fmt(bounds().maxX) + ' × ' + fmt(bounds().maxY) + ' m\n\n';
      s += 'MUROS [tipo  (x1,y1)→(x2,y2)  long]:\n';
      geom.walls.forEach((w, i) => { s += `  ${i + 1}. ${w.type}  (${fmt(w.x1)},${fmt(w.y1)})→(${fmt(w.x2)},${fmt(w.y2)})  L=${fmt(wallLen(w))}\n`; });
      s += '\nVENTANAS [muro fixed  a→b  ancho]:\n';
      geom.windows.forEach((w, i) => { s += `  ${i + 1}. ${w.wall} @${fmt(w.fixed)}  ${fmt(w.a)}→${fmt(w.b)}  (${fmt(w.b - w.a)})\n`; });
      s += '\nPUERTAS CORREDIZAS [muro fixed  a→b  ancho]:\n';
      geom.sliders.forEach((w, i) => { s += `  ${i + 1}. ${w.wall} @${fmt(w.fixed)}  ${fmt(w.a)}→${fmt(w.b)}  (${fmt(w.b - w.a)})\n`; });
      s += '\nPUERTAS [muro  hinge(hx,hy)  ancho  along  open]:\n';
      geom.doors.forEach((d, i) => { s += `  ${i + 1}. ${d.wall}  (${fmt(d.hx)},${fmt(d.hy)})  w=${fmt(d.w)}  along=[${d.along}] open=[${d.open}]\n`; });
      const reinf = geom.walls.filter((w) => (w.re || []).length);
      if (reinf.length) {
        s += '\nBLOCKS REFORZADOS (acero) [muro #  índices de block]:\n';
        geom.walls.forEach((w, i) => { if ((w.re || []).length) s += `  muro ${i + 1}: ${w.re.slice().sort((a, b) => a - b).join(', ')}\n`; });
      }
      if ((geom.furniture || []).length) {
        s += '\nMOBILIARIO [tipo  centro(cx,cy)  w×h  rot]:\n';
        geom.furniture.forEach((f, i) => { const cat = (window.PlanFurniture && window.PlanFurniture.CATALOG[f.type]) || {}; s += `  ${i + 1}. ${cat.label || f.type}  (${fmt(f.cx)},${fmt(f.cy)})  ${fmt(f.w)}×${fmt(f.h)}  ${f.rot || 0}°\n`; });
      }
      if ((geom.labels || []).length) {
        s += '\nESPACIOS (etiquetas):\n';
        geom.labels.forEach((l, i) => { s += `  ${i + 1}. ${l.text}  (${fmt(l.cx)},${fmt(l.cy)})\n`; });
      }
      return s;
    }

    // ---- info bar ----
    function updateInfo() {
      const info = document.getElementById('ed_info');
      if (!info) return;
      const b = bounds();
      let txt = `Huella ${fmt(b.maxX)} × ${fmt(b.maxY)} m · Área bruta ${fmt(footprintArea())} m²`;
      if (sel) {
        const o = find(sel.kind, sel.id);
        if (o) {
          if (sel.kind === 'wall') txt += `  ·  ✦ Muro: L = ${fmt(wallLen(o))} m` + (blockMode ? ` · ${wallBlocks(o).length} blocks · ${(o.re || []).length} reforzados` : '');
          else if (sel.kind === 'window') txt += `  ·  ✦ Ventana: ancho ${fmt(o.b - o.a)} m`;
          else if (sel.kind === 'slider') txt += `  ·  ✦ Corrediza: ancho ${fmt(o.b - o.a)} m`;
          else if (sel.kind === 'furn') { const cat = (window.PlanFurniture && window.PlanFurniture.CATALOG[o.type]) || {}; txt += `  ·  ✦ ${cat.label || o.type}: ${fmt(o.w)}×${fmt(o.h)} m · ${o.rot || 0}°`; }
          else txt += `  ·  ✦ Puerta: ancho ${fmt(o.w)} m`;
        }
      }
      info.textContent = txt;
      // mostrar/ocultar acciones de puerta
      const da = document.getElementById('ed_dooracts');
      if (da) da.style.display = sel && sel.kind === 'door' ? 'flex' : 'none';
      const wa = document.getElementById('ed_widthacts');
      if (wa) wa.style.display = sel && (sel.kind === 'window' || sel.kind === 'slider' || sel.kind === 'door') ? 'flex' : 'none';
      const la = document.getElementById('ed_wallacts');
      if (la) la.style.display = sel && sel.kind === 'wall' && blockMode ? 'flex' : 'none';
      const fa = document.getElementById('ed_furnacts');
      if (fa) fa.style.display = sel && sel.kind === 'furn' ? 'flex' : 'none';
      if (sel && sel.kind === 'furn') {
        const o = find('furn', sel.id);
        const wi = document.getElementById('ck_furn_w'), hi = document.getElementById('ck_furn_h');
        if (o && wi && document.activeElement !== wi) wi.value = Math.round(o.w * 100);
        if (o && hi && document.activeElement !== hi) hi.value = Math.round(o.h * 100);
      }
      const xa = document.getElementById('ed_delbtn');
      if (xa) xa.style.display = sel ? 'inline-flex' : 'none';
    }

    // ---- API pública ----
    this.init = function () { load(); render(); document.addEventListener('keydown', onKey); document.addEventListener('keyup', onKeyUp); };
    this.setSnap = (v) => { snap = v; render(); };
    this.setWallCm = (v) => { wallCm = v; render(); };
    this.setShowLen = (v) => { showLen = v; render(); };
    this.undo = undo;
    this.reset = reset;
    this.flipHinge = flipHinge;
    this.flipSwing = flipSwing;
    this.delSel = delSel;
    this.summary = summary;
    this.startPlace = startPlace;
    this.widen = widen;
    this.setBlockMode = (v) => { blockMode = v; render(); };
    this.setBlockLen = (cm) => { pushHistory(); geom.blockLen = Math.max(0.10, cm / 100); save(); render(); };
    this.setJoint = (cm) => { pushHistory(); geom.joint = Math.max(0, cm / 100); save(); render(); };
    this.getBlockLen = () => Math.round((geom.blockLen || DEF_BLOCK_LEN) * 100);
    this.getJoint = () => Math.round((geom.joint != null ? geom.joint : DEF_JOINT) * 100);
    this.reinforceAll = reinforceAll;
    this.rotateSel = rotateSel;
    this.placeFurni = (type) => startPlace('furn:' + type);
    this.placeLabel = (text) => startPlace('label:' + String(text || 'Espacio'));
    this.cancelPlace = () => { if (placing) { placing = null; if (svgEl) svgEl.style.cursor = ''; render(); } };
    // exportar el croquis como PNG (para compartir por WhatsApp)
    this.exportPNG = (cb) => {
      try {
        const svg = svgEl.cloneNode(true);
        svg.setAttribute('viewBox', '0 0 ' + VW + ' ' + VH);
        svg.setAttribute('width', VW); svg.setAttribute('height', VH);
        const xml = new XMLSerializer().serializeToString(svg);
        const img = new Image();
        img.onload = function () {
          const sc = 2, cv = document.createElement('canvas');
          cv.width = VW * sc; cv.height = VH * sc;
          const ctx = cv.getContext('2d'); ctx.fillStyle = '#fbfaf8'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.scale(sc, sc); ctx.drawImage(img, 0, 0);
          cv.toBlob(function (blob) { cb && cb(blob); }, 'image/png');
        };
        img.onerror = function () { cb && cb(null); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      } catch (e) { cb && cb(null); }
    };
    // zoom / desplazamiento (solo vista)
    this.zoomIn = () => zoomCenter(1.25);
    this.zoomOut = () => zoomCenter(1 / 1.25);
    this.zoomFit = () => { vb = null; applyVB(); };
    this.setPanMode = (on) => { panMode = !!on; if (svgEl) svgEl.style.cursor = on ? 'grab' : ''; };
    // editar tamaño del mueble seleccionado (cm)
    this.setFurnW = (cm) => { const o = find('furn', sel && sel.id); if (!o) return; pushHistory(); o.w = Math.max(0.10, round2((parseFloat(cm) || 0) / 100)); save(); render(); };
    this.setFurnH = (cm) => { const o = find('furn', sel && sel.id); if (!o) return; pushHistory(); o.h = Math.max(0.10, round2((parseFloat(cm) || 0) / 100)); save(); render(); };
    this.getSelFurni = () => { const o = find('furn', sel && sel.id); return o ? { w: Math.round(o.w * 100), h: Math.round(o.h * 100) } : null; };
    this.getGeom = () => geom;
    this.exportJSON = () => JSON.stringify(geom, null, 2);
    this.loadGeom = (obj) => {
      if (!obj || !Array.isArray(obj.walls)) return false;
      clearHistory();                                // evita que Deshacer traiga geometría de OTRO proyecto
      geom = obj; normalize(); sel = null; save(); render(); return true;
    };
    this.clearHistory = clearHistory;
    this.redo = redoAct;
    // guardado con nombre en localStorage (no se borra al restablecer)
    this.saveSlot = (name) => {
      try {
        const slots = JSON.parse(localStorage.getItem('marbel_slots') || '{}');
        slots[name] = { ts: Date.now(), geom };
        localStorage.setItem('marbel_slots', JSON.stringify(slots));
        return true;
      } catch (e) { return false; }
    };
    this.listSlots = () => {
      try { const s = JSON.parse(localStorage.getItem('marbel_slots') || '{}'); return Object.keys(s).map((k) => ({ name: k, ts: s[k].ts })); } catch (e) { return []; }
    };
    this.loadSlot = (name) => {
      try { const s = JSON.parse(localStorage.getItem('marbel_slots') || '{}'); if (s[name]) { return this.loadGeom(s[name].geom); } } catch (e) {}
      return false;
    };
    this.deleteSlot = (name) => {
      try { const s = JSON.parse(localStorage.getItem('marbel_slots') || '{}'); delete s[name]; localStorage.setItem('marbel_slots', JSON.stringify(s)); return true; } catch (e) { return false; }
    };
  }

  window.PlanEditor = PlanEditor;
})();
