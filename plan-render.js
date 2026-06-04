/* ============================================================
   Plano arquitectónico — renderizador SVG paramétrico
   Sistema de coordenadas: metros, origen (0,0) = esquina sup-izq
   (eje de muro). y crece hacia abajo. 1 m = PPM px.
   ============================================================ */
(function () {
  'use strict';

  // ---- Geometría del proyecto (metros, ejes de muro) ----
  // (el espesor T es paramétrico — ver renderPlan)

  // Envolvente (forma de L) y muros interiores. Cada muro: eje
  const WALLS = [
    // perímetro exterior (L)
    ['ext', 0, 0, 8.0, 0],       // superior
    ['ext', 8.0, 0, 8.0, 3.6],   // derecha-superior
    ['ext', 8.0, 3.6, 5.0, 3.6], // escalón (bajo Camila)
    ['ext', 5.0, 3.6, 5.0, 9.4], // este-inferior
    ['ext', 5.0, 9.4, 0, 9.4],   // inferior
    ['ext', 0, 9.4, 0, 0],       // izquierda
    // interiores
    ['int', 4.15, 0, 4.15, 3.6],     // divisorio recámaras (eje B, respaldo de clósets)
    ['int', 3.55, 2.40, 4.75, 2.40], // muro perpendicular (tope inferior de clósets)
    ['int', 0, 3.6, 5.0, 3.6],       // eje 2 (recámaras / pasillo)
    // baño (caja)
    ['int', 0, 5.0, 2.7, 5.0],
    ['int', 2.7, 5.0, 2.7, 6.5],
    ['int', 0, 6.5, 2.7, 6.5],
  ];

  // Vanos (puertas). along = vector eje cerrado, open = vector apertura
  const DOORS = [
    // recámara principal — muro eje 2, izquierda del clóset, abre al pasillo
    { hx: 2.45, hy: 3.6, w: 0.80, along: [1, 0], open: [0, 1], wall: 'h' },
    // recámara camila — muro eje 2, derecha del clóset, abre al pasillo
    { hx: 4.20, hy: 3.6, w: 0.75, along: [1, 0], open: [0, 1], wall: 'h' },
    // baño — muro y=5.0, abre hacia adentro (abajo)
    { hx: 0.95, hy: 5.0, w: 0.80, along: [1, 0], open: [0, 1], wall: 'h' },
    // acceso — muro este (eje C), parte alta, abre al pasillo (oeste)
    { hx: 5.0, hy: 3.6, w: 0.95, along: [0, 1], open: [-1, 0], wall: 'v' },
  ];

  // Puertas corredizas tipo ventana (paño a paño). {wall, fixed, a, b}
  const SLIDERS = [
    { wall: 'v', fixed: 0, a: 3.6, b: 5.0 }, // muro oeste: del eje 2 al muro del baño
  ];

  // Clósets recargados al muro B, corren del muro perpendicular (y=2.40) al eje 1 (y=0). face: lado de apertura
  const CLOSETS = [
    { x: 3.55, y: 0.0, w: 0.60, hgt: 2.40, face: 'W' }, // principal → abre al oeste
    { x: 4.15, y: 0.0, w: 0.60, hgt: 2.40, face: 'E' }, // camila → abre al este
  ];

  // Ventanas: lista de {wall:'h'|'v', fixed, a, b}
  const WINDOWS = [
    { wall: 'h', fixed: 0,   a: 1.20, b: 2.50 }, // superior (principal)
    { wall: 'v', fixed: 0,   a: 0.90, b: 2.10 }, // izq (principal)
    { wall: 'v', fixed: 0,   a: 7.20, b: 8.30 }, // izq (sala tv)
    { wall: 'v', fixed: 8.0, a: 0.90, b: 2.10 }, // der (camila)
    { wall: 'v', fixed: 5.0, a: 5.20, b: 6.45 }, // este (cocina)
  ];

  // Habitaciones (relleno hasta eje) + etiqueta
  const ROOMS = [
    { key: 'principal', x: 0,    y: 0,   w: 4.15, hgt: 3.6, name: 'RECÁMARA PRINCIPAL', area: '13.40' },
    { key: 'camila',    x: 4.15, y: 0,   w: 3.85, hgt: 3.6, name: 'RECÁMARA CAMILA',    area: '12.40' },
    { key: 'bano',      x: 0,    y: 5.0, w: 2.7,  hgt: 1.5, name: 'BAÑO COMPLETO',       area: '3.30' },
  ];

  // ---- helpers svg ----
  const esc = (s) => String(s);
  function el(tag, attrs, inner) {
    let s = '<' + tag;
    for (const k in attrs) s += ' ' + k + '="' + attrs[k] + '"';
    s += inner != null ? '>' + inner + '</' + tag + '>' : '/>';
    return s;
  }
  const BLOCK_LEN = 0.40, JOINT = 0.01;
  const _isH = (w) => Math.abs(w.y1 - w.y2) < 1e-6;
  function _wallBlocks(w, bl, jt) {
    const horizontal = _isH(w);
    const lo = horizontal ? Math.min(w.x1, w.x2) : Math.min(w.y1, w.y2);
    const hi = horizontal ? Math.max(w.x1, w.x2) : Math.max(w.y1, w.y2);
    const fixed = horizontal ? w.y1 : w.x1;
    const BL = bl || BLOCK_LEN, JT = jt != null ? jt : JOINT;
    const blocks = []; let s = lo, idx = 0;
    while (s < hi - 0.02) { const e = Math.min(s + BL, hi); blocks.push({ idx, s, e, fixed, horizontal }); s = e + JT; idx++; }
    return blocks;
  }

  // ============================================================
  function renderPlan(baseTheme, opts) {
    opts = opts || {};
    const T = (opts.wallCm != null ? opts.wallCm : 20) / 100;   // espesor de muro (m)
    const finish = opts.finish || 'paper';
    const detail = opts.detail || 'completo';
    const detailed = detail === 'completo';

    // --- acabado de lámina: reconfigura papel / tinta / muros / tintes ---
    const theme = Object.assign({}, baseTheme, { fill: Object.assign({}, baseTheme.fill) });
    const tinted = baseTheme.fill.principal !== '#ffffff';
    if (finish === 'blueprint') {
      theme.paper = '#15375c';
      theme.ink = '#dce9f7';
      theme.wall = '#eaf2fb';
      theme.grid = 'rgba(220,233,247,0.22)';
      theme.hatchPorche = true;
      ['social', 'porche', 'principal', 'camila', 'bano'].forEach((k) => theme.fill[k] = tinted ? 'rgba(220,233,247,0.09)' : 'rgba(220,233,247,0.0)');
    } else if (finish === 'vellum') {
      theme.paper = '#f1e9d6';
      theme.ink = '#4a4030';
      theme.wall = baseTheme.wall === '#ffffff' ? '#4a4030' : (/^#(1|0)/.test(baseTheme.wall) ? '#33291b' : '#7c7058');
      theme.grid = 'rgba(74,64,48,0.16)';
      if (tinted) theme.fill = { social: '#e9dcbe', porche: '#e2d6ba', principal: '#e4dcc6', camila: '#ebe0c2', bano: '#dfdcc0' };
      else ['social', 'porche', 'principal', 'camila', 'bano'].forEach((k) => theme.fill[k] = '#f1e9d6');
    }

    const PPM = 64;
    const OX = 196, OY = 182;           // px del origen (0,0)
    const X = (m) => OX + m * PPM;
    const Y = (m) => OY + m * PPM;
    const tpx = T * PPM;

    // ---- geometría: original o edición del usuario (opts.geom, formato editor) ----
    const GEO = opts.geom || null;
    const _WALLS = GEO && GEO.walls ? GEO.walls.map((w) => [w.type, w.x1, w.y1, w.x2, w.y2]) : WALLS;
    const _WALLOBJS = GEO && GEO.walls ? GEO.walls : WALLS.map((w) => ({ type: w[0], x1: w[1], y1: w[2], x2: w[3], y2: w[4], re: [] }));
    const _DOORS = GEO && GEO.doors ? GEO.doors : DOORS;
    const _WINDOWS = GEO && GEO.windows ? GEO.windows : WINDOWS;
    const _SLIDERS = GEO && GEO.sliders ? GEO.sliders : SLIDERS;
    const useBlocks = !!opts.blocks;

    const W = 1080, H = 1015;
    const tw = theme.wall;
    let g = '';   // capas

    // ---------- fondo papel ----------
    g += el('rect', { x: 0, y: 0, width: W, height: H, fill: theme.paper });

    // ---------- retícula 1 m ----------
    let grid = '';
    for (let i = 0; i <= 8; i++) grid += el('line', { x1: X(i), y1: Y(0), x2: X(i), y2: Y(9.4), stroke: theme.grid, 'stroke-width': 0.6 });
    for (let j = 0; j <= 9; j++) grid += el('line', { x1: X(0), y1: Y(j), x2: X(8), y2: Y(j), stroke: theme.grid, 'stroke-width': 0.6 });
    grid += el('line', { x1: X(0), y1: Y(9.4), x2: X(8), y2: Y(9.4), stroke: theme.grid, 'stroke-width': 0.6 });
    if (detailed) g += el('g', { opacity: 0.5 }, grid);

    // ---------- rellenos de habitación ----------
    // estancia (L lower-left)
    g += el('rect', { x: X(0), y: Y(3.6), width: (5.0) * PPM, height: (9.4 - 3.6) * PPM, fill: theme.fill.social });
    // porche exterior
    g += el('rect', { x: X(5.0), y: Y(3.6), width: 3.0 * PPM, height: (9.4 - 3.6) * PPM, fill: theme.fill.porche });
    if (theme.hatchPorche) {
      let hatch = '';
      for (let xx = 5.0; xx <= 8.0 + 5.8; xx += 0.5) {
        hatch += el('line', { x1: X(Math.min(xx, 8.0)), y1: Y(3.6 + Math.max(0, xx - 8.0)), x2: X(Math.max(5.0, xx - 5.8)), y2: Y(Math.min(9.4, 3.6 + xx - 5.0)), stroke: theme.wall, 'stroke-width': 0.5, opacity: 0.18 });
      }
      g += hatch;
    }
    ROOMS.forEach((r) => {
      g += el('rect', { x: X(r.x), y: Y(r.y), width: r.w * PPM, height: r.hgt * PPM, fill: theme.fill[r.key] || theme.fill.social });
    });

    // ---------- muros (poché sólido o relleno de blocks) ----------
    let walls = '';
    if (useBlocks) {
      _WALLOBJS.forEach((w) => {
        const re = w.re || [];
        _wallBlocks(w, GEO && GEO.blockLen, GEO && GEO.joint).forEach((bk) => {
          const reinf = re.indexOf(bk.idx) >= 0;
          const bx = bk.horizontal ? X(bk.s) : X(bk.fixed) - tpx / 2;
          const by = bk.horizontal ? Y(bk.fixed) - tpx / 2 : Y(bk.s);
          const bw = bk.horizontal ? (bk.e - bk.s) * PPM : tpx;
          const bh = bk.horizontal ? tpx : (bk.e - bk.s) * PPM;
          walls += el('rect', { x: bx, y: by, width: bw, height: bh, fill: reinf ? tw : (theme.paper === '#15375c' ? 'rgba(220,233,247,0.10)' : '#ece9e2'), stroke: tw, 'stroke-width': reinf ? 1 : 0.9 });
          if (reinf) { const cx = bx + bw / 2, cy = by + bh / 2, rr = Math.max(2, Math.min(tpx * 0.22, bw * 0.18, bh * 0.18, 5)); walls += el('circle', { cx, cy, r: rr, fill: theme.paper, stroke: tw, 'stroke-width': 0.8 }); }
        });
      });
    } else {
      _WALLS.forEach((w) => {
        const [, x1, y1, x2, y2] = w;
        walls += el('line', { x1: X(x1), y1: Y(y1), x2: X(x2), y2: Y(y2), stroke: tw, 'stroke-width': tpx, 'stroke-linecap': 'square' });
      });
    }
    g += walls;

    // ---------- recortar vanos (puertas y ventanas) ----------
    let cuts = '';
    const cut = (cx, cy, cw, ch) => { cuts += el('rect', { x: X(cx) - (cw === 0 ? tpx : 0), y: Y(cy) - (ch === 0 ? tpx : 0), width: cw === 0 ? tpx * 2 : cw * PPM, height: ch === 0 ? tpx * 2 : ch * PPM, fill: theme.paper }); };
    // puertas
    _DOORS.forEach((d) => {
      if (d.wall === 'h') {
        const x0 = Math.min(d.hx, d.hx + d.along[0] * d.w);
        cuts += el('rect', { x: X(x0), y: Y(d.hy) - tpx / 2 - 1, width: d.w * PPM, height: tpx + 2, fill: theme.paper });
      } else {
        const y0 = Math.min(d.hy, d.hy + d.along[1] * d.w);
        cuts += el('rect', { x: X(d.hx) - tpx / 2 - 1, y: Y(y0), width: tpx + 2, height: d.w * PPM, fill: theme.paper });
      }
    });
    // ventanas
    _WINDOWS.forEach((wn) => {
      if (wn.wall === 'h') cuts += el('rect', { x: X(wn.a), y: Y(wn.fixed) - tpx / 2 - 1, width: (wn.b - wn.a) * PPM, height: tpx + 2, fill: theme.paper });
      else cuts += el('rect', { x: X(wn.fixed) - tpx / 2 - 1, y: Y(wn.a), width: tpx + 2, height: (wn.b - wn.a) * PPM, fill: theme.paper });
    });
    // correderas
    _SLIDERS.forEach((s) => {
      if (s.wall === 'h') cuts += el('rect', { x: X(s.a), y: Y(s.fixed) - tpx / 2 - 1, width: (s.b - s.a) * PPM, height: tpx + 2, fill: theme.paper });
      else cuts += el('rect', { x: X(s.fixed) - tpx / 2 - 1, y: Y(s.a), width: tpx + 2, height: (s.b - s.a) * PPM, fill: theme.paper });
    });
    g += cuts;

    // ---------- ventanas (vidrio: 3 líneas) ----------
    let win = '';
    _WINDOWS.forEach((wn) => {
      const sw = 1.4;
      if (wn.wall === 'h') {
        const y = Y(wn.fixed);
        [-tpx / 2, 0, tpx / 2].forEach((off) => win += el('line', { x1: X(wn.a), y1: y + off, x2: X(wn.b), y2: y + off, stroke: tw, 'stroke-width': off === 0 ? sw : sw, opacity: off === 0 ? 1 : 0.9 }));
        win += el('line', { x1: X(wn.a), y1: y - tpx / 2, x2: X(wn.a), y2: y + tpx / 2, stroke: tw, 'stroke-width': sw });
        win += el('line', { x1: X(wn.b), y1: y - tpx / 2, x2: X(wn.b), y2: y + tpx / 2, stroke: tw, 'stroke-width': sw });
      } else {
        const x = X(wn.fixed);
        [-tpx / 2, 0, tpx / 2].forEach((off) => win += el('line', { x1: x + off, y1: Y(wn.a), x2: x + off, y2: Y(wn.b), stroke: tw, 'stroke-width': sw }));
        win += el('line', { x1: x - tpx / 2, y1: Y(wn.a), x2: x + tpx / 2, y2: Y(wn.a), stroke: tw, 'stroke-width': sw });
        win += el('line', { x1: x - tpx / 2, y1: Y(wn.b), x2: x + tpx / 2, y2: Y(wn.b), stroke: tw, 'stroke-width': sw });
      }
    });
    g += win;

    // ---------- puertas corredizas (2 paneles traslapados) ----------
    let sld = '';
    _SLIDERS.forEach((s) => {
      const sw = 1.4, gap = tpx * 0.22;
      if (s.wall === 'v') {
        const x = X(s.fixed), mid = (s.a + s.b) / 2;
        // jambas
        sld += el('line', { x1: x - tpx / 2, y1: Y(s.a), x2: x + tpx / 2, y2: Y(s.a), stroke: tw, 'stroke-width': sw });
        sld += el('line', { x1: x - tpx / 2, y1: Y(s.b), x2: x + tpx / 2, y2: Y(s.b), stroke: tw, 'stroke-width': sw });
        // panel exterior (mitad superior) y panel interior (mitad inferior, traslapado)
        sld += el('rect', { x: x - gap - 1.2, y: Y(s.a) + 1, width: 2.4, height: (mid - s.a) * PPM + 2, fill: 'none', stroke: tw, 'stroke-width': sw });
        sld += el('rect', { x: x + gap - 1.2, y: Y(mid) - 1, width: 2.4, height: (s.b - mid) * PPM + 2, fill: 'none', stroke: tw, 'stroke-width': sw });
      } else {
        const y = Y(s.fixed), mid = (s.a + s.b) / 2;
        sld += el('line', { x1: X(s.a), y1: y - tpx / 2, x2: X(s.a), y2: y + tpx / 2, stroke: tw, 'stroke-width': sw });
        sld += el('line', { x1: X(s.b), y1: y - tpx / 2, x2: X(s.b), y2: y + tpx / 2, stroke: tw, 'stroke-width': sw });
        sld += el('rect', { x: X(s.a) + 1, y: y - gap - 1.2, width: (mid - s.a) * PPM + 2, height: 2.4, fill: 'none', stroke: tw, 'stroke-width': sw });
        sld += el('rect', { x: X(mid) - 1, y: y + gap - 1.2, width: (s.b - mid) * PPM + 2, height: 2.4, fill: 'none', stroke: tw, 'stroke-width': sw });
      }
    });
    g += sld;

    // ---------- clósets empotrados (líneas finas + puertas corredizas) ----------
    let clo = '';
    const cinkW = 1.2;
    CLOSETS.forEach((c) => {
      // contorno del clóset
      clo += el('rect', { x: X(c.x), y: Y(c.y), width: c.w * PPM, height: c.hgt * PPM, fill: 'none', stroke: tw, 'stroke-width': cinkW, opacity: 0.85 });
      // barra de colgar (línea punteada paralela al respaldo / muro B)
      // cara de apertura con paneles corredizos
      if (c.face === 'W') {
        const fx = X(c.x);                       // cara oeste
        clo += el('line', { x1: fx + 2, y1: Y(c.y) + 3, x2: fx + 2, y2: Y(c.y + c.hgt) - 3, stroke: tw, 'stroke-width': 1, 'stroke-dasharray': '2 3', opacity: 0.6 });
        clo += el('rect', { x: fx - 1.2, y: Y(c.y) + 2, width: 2.4, height: (c.hgt / 2) * PPM, fill: 'none', stroke: tw, 'stroke-width': 1.3 });
        clo += el('rect', { x: fx + 3, y: Y(c.y + c.hgt / 2), width: 2.4, height: (c.hgt / 2) * PPM - 2, fill: 'none', stroke: tw, 'stroke-width': 1.3 });
      } else {
        const fx = X(c.x + c.w);                 // cara este
        clo += el('line', { x1: fx - 2, y1: Y(c.y) + 3, x2: fx - 2, y2: Y(c.y + c.hgt) - 3, stroke: tw, 'stroke-width': 1, 'stroke-dasharray': '2 3', opacity: 0.6 });
        clo += el('rect', { x: fx - 1.2, y: Y(c.y) + 2, width: 2.4, height: (c.hgt / 2) * PPM, fill: 'none', stroke: tw, 'stroke-width': 1.3 });
        clo += el('rect', { x: fx - 3 - 2.4, y: Y(c.y + c.hgt / 2), width: 2.4, height: (c.hgt / 2) * PPM - 2, fill: 'none', stroke: tw, 'stroke-width': 1.3 });
      }
    });
    g += clo;
    let doors = '';
    _DOORS.forEach((d) => {
      const wpx = d.w * PPM;
      const hX = X(d.hx), hY = Y(d.hy);
      const aTipX = hX + d.along[0] * wpx, aTipY = hY + d.along[1] * wpx;   // jamba opuesta
      const oTipX = hX + d.open[0] * wpx, oTipY = hY + d.open[1] * wpx;     // hoja abierta
      // hoja
      doors += el('line', { x1: hX, y1: hY, x2: oTipX, y2: oTipY, stroke: tw, 'stroke-width': 2 });
      // barrido (arco 90°, convexo: centrado en la bisagra)
      const cross = d.along[0] * d.open[1] - d.along[1] * d.open[0];
      const sweep = cross > 0 ? 0 : 1;
      doors += el('path', { d: `M ${oTipX} ${oTipY} A ${wpx} ${wpx} 0 0 ${sweep} ${aTipX} ${aTipY}`, fill: 'none', stroke: tw, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.75 });
    });
    g += doors;

    // ---------- MOBILIARIO (capa fina, opcional) ----------
    const userFurn = GEO && GEO.furniture && GEO.furniture.length ? GEO.furniture : null;
    if (opts.furnished && userFurn && window.PlanFurniture) {
      let fu = '';
      userFurn.forEach((f) => {
        const sym = window.PlanFurniture.draw(f.type, f.w * PPM, f.h * PPM, theme.ink, 1.1);
        fu += el('g', { transform: `translate(${X(f.cx)} ${Y(f.cy)}) rotate(${f.rot || 0})`, opacity: 0.78 }, sym);
      });
      g += fu;
    } else if (opts.furnished) {
      const fink = theme.ink;
      const F = { fill: 'none', stroke: fink, 'stroke-width': 1.1, opacity: 0.7, 'stroke-linejoin': 'round' };
      const SOFT = theme.paper === '#15375c' ? 'rgba(220,233,247,0.05)' : 'rgba(0,0,0,0.025)';
      const fr = (x, y, w, hh, ex) => el('rect', Object.assign({ x: X(x), y: Y(y), width: w * PPM, height: hh * PPM }, F, ex || {}));
      const fl = (x1, y1, x2, y2, ex) => el('line', Object.assign({ x1: X(x1), y1: Y(y1), x2: X(x2), y2: Y(y2) }, F, ex || {}));
      const fe = (cx, cy, rx, ry, ex) => el('ellipse', Object.assign({ cx: X(cx), cy: Y(cy), rx: rx * PPM, ry: ry * PPM }, F, ex || {}));
      let fu = '';

      // -- cama: x,y esquina, w (ancho colchón), L (largo), head: 'N''S''E''W'
      function bed(x, y, w, L, head) {
        let s = fr(x, y, w, L, { rx: 4, fill: SOFT });
        const hb = 0.14, pad = 0.1, pw = (w - pad * 3) / 2, pl = 0.36;
        if (head === 'N') { s += fr(x, y - hb, w, hb, { rx: 2 }); s += fr(x + pad, y + 0.06, pw, pl, { rx: 3 }) + fr(x + pad * 2 + pw, y + 0.06, pw, pl, { rx: 3 }); s += fl(x + 0.03, y + L - 0.34, x + w - 0.03, y + L - 0.34); }
        else if (head === 'S') { s += fr(x, y + L, w, hb, { rx: 2 }); s += fr(x + pad, y + L - 0.06 - pl, pw, pl, { rx: 3 }) + fr(x + pad * 2 + pw, y + L - 0.06 - pl, pw, pl, { rx: 3 }); s += fl(x + 0.03, y + 0.34, x + w - 0.03, y + 0.34); }
        else if (head === 'W') { s += fr(x - hb, y, hb, w, { rx: 2 }); }
        else { s += fr(x + L, y, hb, w, { rx: 2 }); }
        return s;
      }
      function clthr(x, y, w, hh) { // clóset con líneas de puertas corredizas
        let s = fr(x, y, w, hh, {});
        const n = Math.max(2, Math.round(w / 0.6));
        for (let i = 1; i < n; i++) s += fl(x + (w / n) * i, y, x + (w / n) * i, y + hh, { opacity: 0.45 });
        return s;
      }

      // RECÁMARA PRINCIPAL — cama cabecera norte (a la derecha de la ventana) + clóset sur
      fu += bed(2.35, 0.18, 1.55, 2.0, 'N');
      fu += fr(1.92, 0.18, 0.4, 0.42, { rx: 2 });            // buró
      fu += clthr(0.35, 2.95, 1.85, 0.45);                   // clóset

      // RECÁMARA CAMILA — cama individual cabecera norte (izquierda) + clóset sur
      fu += bed(4.55, 0.18, 1.3, 1.95, 'N');
      fu += fr(5.85, 0.18, 0.4, 0.42, { rx: 2 });            // buró
      fu += clthr(6.05, 2.95, 1.7, 0.45);                    // clóset

      // BAÑO — tina (izq) + WC (arriba der) + lavabo (abajo centro)
      fu += fr(0.18, 5.18, 0.58, 1.16, { rx: 4, fill: SOFT });   // tina
      fu += fe(0.47, 5.95, 0.18, 0.34);                          // interior tina
      fu += fr(1.96, 5.16, 0.46, 0.30, { rx: 2 });               // tanque WC
      fu += fe(2.19, 5.62, 0.18, 0.2, { fill: SOFT });           // taza WC
      fu += fr(1.02, 6.04, 0.55, 0.3, { rx: 3 });                // mueble lavabo
      fu += fe(1.295, 6.19, 0.16, 0.1);                          // ovalín

      // COCINA — barra en L sobre muro este (eje C) + tarja + estufa
      fu += fr(4.30, 4.55, 0.58, 3.85, { fill: SOFT });          // barra galera
      fu += fe(4.59, 5.18, 0.16, 0.18);                          // tarja
      fu += fr(4.40, 6.95, 0.42, 0.5, { rx: 2 });                // estufa
      [0, 1].forEach((i) => [0, 1].forEach((j) => fu += fe(4.50 + i * 0.22, 7.08 + j * 0.24, 0.06, 0.06)));
      // tramo bajo (mostrador inferior frente a sala)
      fu += fr(3.55, 7.95, 0.7, 0.5, { fill: SOFT });            // isla/mostrador

      // COMEDOR — mesa + 4 sillas
      fu += fr(1.55, 4.02, 1.15, 0.78, { rx: 3, fill: SOFT });
      fu += fr(1.62, 3.72, 0.4, 0.26, { rx: 2 }) + fr(2.23, 3.72, 0.4, 0.26, { rx: 2 });
      fu += fr(1.62, 4.84, 0.4, 0.26, { rx: 2 }) + fr(2.23, 4.84, 0.4, 0.26, { rx: 2 });

      // SALA TV — sofá (muro oeste) + mesa de centro + mueble TV
      fu += fr(0.18, 7.25, 0.62, 1.7, { rx: 4, fill: SOFT });    // sofá
      fu += fl(0.5, 7.25, 0.5, 8.95);                            // respaldo/asiento
      fu += fr(1.2, 7.78, 0.72, 0.5, { rx: 3 });                 // mesa de centro
      fu += fr(2.92, 7.45, 0.22, 1.3, { rx: 2, fill: SOFT });    // mueble TV

      g += el('g', {}, fu);
    }

    let steps = '';
    // 3 peldaños descendiendo al sur, dentro del porche
    for (let s = 0; s <= 3; s++) {
      steps += el('line', { x1: X(5.55 + s * 0.12), y1: Y(8.55 + s * 0.28), x2: X(7.65 - s * 0.12), y2: Y(8.55 + s * 0.28), stroke: theme.ink, 'stroke-width': 0.9, opacity: 0.45 });
    }
    // flecha de bajada
    steps += el('line', { x1: X(6.6), y1: Y(8.5), x2: X(6.6), y2: Y(9.35), stroke: theme.ink, 'stroke-width': 0.9, opacity: 0.5 });
    steps += el('path', { d: `M ${X(6.6) - 4} ${Y(9.2)} L ${X(6.6)} ${Y(9.38)} L ${X(6.6) + 4} ${Y(9.2)}`, fill: 'none', stroke: theme.ink, 'stroke-width': 0.9, opacity: 0.5 });
    steps += el('text', { x: X(6.6), y: Y(8.42), 'text-anchor': 'middle', fill: theme.ink, 'font-size': 9.5, 'font-family': 'var(--fl)', 'letter-spacing': '1', opacity: 0.5 }, 'ESCALONES');
    g += steps;

    // ---------- símbolo de nivel / acceso ----------
    g += el('path', { d: `M ${X(6.5) - 7} ${Y(4.55) - 7} L ${X(6.5) + 7} ${Y(4.55) - 7} L ${X(6.5)} ${Y(4.55) + 6} Z`, fill: 'none', stroke: theme.ink, 'stroke-width': 1.2 });
    g += el('text', { x: X(6.5), y: Y(4.55) - 14, 'text-anchor': 'middle', fill: theme.ink, 'font-size': 15, 'font-family': 'var(--fl)', 'letter-spacing': '1.5', 'font-weight': 600 }, 'ACCESO');

    // ---------- etiquetas de habitación ----------
    const label = (cx, cy, name, area, sub) => {
      let t = '';
      const lines = name.split('\n');
      lines.forEach((ln, i) => {
        t += el('text', { x: X(cx), y: Y(cy) + i * 18 - (lines.length - 1) * 9 - (area ? 10 : 0), 'text-anchor': 'middle', fill: theme.ink, 'font-size': 15.5, 'font-family': 'var(--fl)', 'letter-spacing': '1.2', 'font-weight': 600 }, ln);
      });
      if (area) t += el('text', { x: X(cx), y: Y(cy) + (lines.length - 1) * 9 + 14, 'text-anchor': 'middle', fill: theme.ink, 'font-size': 14, 'font-family': 'var(--fl)', 'letter-spacing': '0.5', opacity: 0.78 }, area + ' m²');
      return t;
    };
    const furnished = !!opts.furnished;
    if (furnished) {
      g += label(1.18, 1.45, 'RECÁMARA\nPRINCIPAL', '13.40');
      g += label(6.95, 1.45, 'RECÁMARA\nCAMILA', '12.40');
      g += label(1.35, 5.52, 'BAÑO', '3.30');
      g += label(2.55, 8.62, 'SALA · COMEDOR · COCINA', '22.30');
    } else {
      g += label(2.07, 1.8, 'RECÁMARA\nPRINCIPAL', '13.40');
      g += label(6.07, 1.8, 'RECÁMARA\nCAMILA', '12.40');
      g += label(1.35, 5.75, 'BAÑO', '3.30');
      g += label(2.5, 8.55, 'SALA · COMEDOR · COCINA', '22.30');
      g += el('text', { x: X(2.5), y: Y(8.55) + 30, 'text-anchor': 'middle', fill: theme.ink, 'font-size': 11, 'font-family': 'var(--fl)', 'letter-spacing': '2', opacity: 0.55 }, 'PLANTA ABIERTA');
    }
    // zonas (sutiles)
    const zone = (cx, cy, txt) => el('text', { x: X(cx), y: Y(cy), 'text-anchor': 'middle', fill: theme.ink, 'font-size': 12.5, 'font-family': 'var(--fl)', 'letter-spacing': '1.5', opacity: 0.62, 'font-weight': 500 }, txt);
    if (detailed) {
      g += zone(furnished ? 3.5 : 3.05, furnished ? 4.3 : 4.35, 'PASILLO');
      g += zone(furnished ? 1.95 : 2.2, furnished ? 6.95 : 7.0, 'SALA TV');
      if (!furnished) {
        // cocina vertical
        g += el('text', { x: X(4.55), y: Y(7.0), 'text-anchor': 'middle', fill: theme.ink, 'font-size': 12.5, 'font-family': 'var(--fl)', 'letter-spacing': '2', opacity: 0.62, 'font-weight': 500, transform: `rotate(-90 ${X(4.55)} ${Y(7.0)})` }, 'COCINA');
      }
    }
    g += el('text', { x: X(6.5), y: Y(6.6), 'text-anchor': 'middle', fill: theme.ink, 'font-size': 12, 'font-family': 'var(--fl)', 'letter-spacing': '1.5', opacity: 0.5, 'font-weight': 500 }, 'PORCHE');

    // ============================================================
    //  EJES (axes) + bubbles
    // ============================================================
    const vAxes = [ ['A', 0], ['B', 2.70], ['C', 4.15], ['D', 5.0], ['E', 8.0] ];
    const hAxes = [ ['1', 0], ['2', 2.40], ['3', 3.6], ['4', 5.0], ['5', 6.5], ['6', 9.4] ];
    const axTop = OY - 118;       // y de los globos verticales
    const axLeft = OX - 128;      // x de los globos horizontales
    const R = 15;
    let axes = '';
    const dashAxis = { stroke: theme.ink, 'stroke-width': 0.8, 'stroke-dasharray': '10 3 2 3', opacity: 0.55 };
    vAxes.forEach(([lab, m]) => {
      axes += el('line', Object.assign({ x1: X(m), y1: axTop + R, x2: X(m), y2: Y(9.4) + 6 }, dashAxis));
      axes += el('circle', { cx: X(m), cy: axTop, r: R, fill: theme.paper, stroke: theme.ink, 'stroke-width': 1.2 });
      axes += el('text', { x: X(m), y: axTop + 5, 'text-anchor': 'middle', fill: theme.ink, 'font-size': 15, 'font-family': 'var(--fl)', 'font-weight': 600 }, lab);
    });
    hAxes.forEach(([lab, m]) => {
      axes += el('line', Object.assign({ x1: axLeft + R, y1: Y(m), x2: X(8) + 6, y2: Y(m) }, dashAxis));
      axes += el('circle', { cx: axLeft, cy: Y(m), r: R, fill: theme.paper, stroke: theme.ink, 'stroke-width': 1.2 });
      axes += el('text', { x: axLeft, y: Y(m) + 5, 'text-anchor': 'middle', fill: theme.ink, 'font-size': 15, 'font-family': 'var(--fl)', 'font-weight': 600 }, lab);
    });
    g += el('g', {}, axes);

    // ============================================================
    //  COTAS (dimensions)
    // ============================================================
    const ink = theme.ink;
    function dimText(s) { return s; }
    // cota horizontal: en y=py, de x=a a x=b (metros)
    function dimH(a, b, py, txt, opt) {
      opt = opt || {};
      const x1 = X(a), x2 = X(b), y = py;
      let s = '';
      s += el('line', { x1, y1: y, x2, y2: y, stroke: ink, 'stroke-width': 0.9 });
      // ticks 45°
      [x1, x2].forEach((xx) => s += el('line', { x1: xx - 4, y1: y + 4, x2: xx + 4, y2: y - 4, stroke: ink, 'stroke-width': 1.1 }));
      // líneas de referencia
      if (opt.ext !== false) {
        s += el('line', { x1, y1: opt.refTo != null ? opt.refTo : y - 6, x2: x1, y2: y + 6, stroke: ink, 'stroke-width': 0.5, opacity: 0.4 });
        s += el('line', { x1: x2, y1: opt.refTo != null ? opt.refTo : y - 6, x2: x2, y2: y + 6, stroke: ink, 'stroke-width': 0.5, opacity: 0.4 });
      }
      s += el('text', { x: (x1 + x2) / 2, y: y - 5, 'text-anchor': 'middle', fill: ink, 'font-size': 12.5, 'font-family': 'var(--fl)', 'font-weight': 500, 'letter-spacing': '0.3' }, txt);
      return s;
    }
    function dimV(a, b, px, txt) {
      const y1 = Y(a), y2 = Y(b), x = px;
      let s = '';
      s += el('line', { x1: x, y1, x2: x, y2, stroke: ink, 'stroke-width': 0.9 });
      [y1, y2].forEach((yy) => s += el('line', { x1: x - 4, y1: yy + 4, x2: x + 4, y2: yy - 4, stroke: ink, 'stroke-width': 1.1 }));
      const mx = (y1 + y2) / 2;
      s += el('text', { x: x - 5, y: mx, 'text-anchor': 'middle', fill: ink, 'font-size': 12.5, 'font-family': 'var(--fl)', 'font-weight': 500, transform: `rotate(-90 ${x - 5} ${mx})` }, txt);
      return s;
    }
    let dims = '';
    // ---- horizontales superiores (entre ejes) ----
    const dyOverall = OY - 62, dyBay = OY - 30;
    dims += dimH(0, 2.70, dyBay, '2.70');
    dims += dimH(2.70, 4.15, dyBay, '1.45');
    dims += dimH(4.15, 5.0, dyBay, '0.85');
    dims += dimH(5.0, 8.0, dyBay, '3.00');
    dims += dimH(0, 8.0, dyOverall, '8.00');
    // ---- verticales izquierdas (entre ejes) ----
    const dxOverall = OX - 70, dxBay = OX - 40;
    dims += dimV(0, 2.40, dxBay, '2.40');
    dims += dimV(2.40, 3.6, dxBay, '1.20');
    dims += dimV(3.6, 5.0, dxBay, '1.40');
    dims += dimV(5.0, 6.5, dxBay, '1.50');
    dims += dimV(6.5, 9.4, dxBay, '2.90');
    dims += dimV(0, 9.4, dxOverall, '9.40');
    // ---- inferior (bloque social) ----
    dims += dimH(0, 5.0, Y(9.4) + 36, '5.00');

    // ---- cotas interiores (paño a paño) ----
    let idim = '';
    // recámara principal
    idim += dimH(0.1, 4.05, Y(2.92), '3.95');
    idim += dimV(0.1, 3.5, X(0.42), '3.40');
    // recámara camila
    idim += dimH(4.25, 7.9, Y(2.92), '3.65');
    idim += dimV(0.1, 3.5, X(7.58), '3.40');
    // baño
    idim += dimH(0.1, 2.6, Y(5.30), '2.50');
    idim += dimV(5.1, 6.4, X(2.32), '1.30');
    // estancia (ancho interior)
    idim += dimH(0.1, 4.9, Y(9.06), '4.80');

    g += el('g', { opacity: 0.92 }, dims);
    g += el('g', { opacity: 0.78 }, idim);

    // ============================================================
    //  PANEL DERECHO: norte, cuadro de áreas, escala
    // ============================================================
    const RX = 716, RW = W - RX - 24;
    let panel = '';
    // norte
    const nx = RX + 46, ny = 250;
    panel += el('circle', { cx: nx, cy: ny, r: 34, fill: 'none', stroke: ink, 'stroke-width': 1 });
    panel += el('path', { d: `M ${nx} ${ny - 40} L ${nx - 9} ${ny + 6} L ${nx} ${ny - 6} L ${nx + 9} ${ny + 6} Z`, fill: ink });
    panel += el('text', { x: nx, y: ny - 46, 'text-anchor': 'middle', fill: ink, 'font-size': 15, 'font-family': 'var(--fl)', 'font-weight': 700 }, 'N');

    // cuadro de áreas
    const cax = RX, cay = 318, caw = RW;
    const rowsData = [
      ['RECÁMARA PRINCIPAL', '13.40'],
      ['RECÁMARA CAMILA', '12.40'],
      ['BAÑO COMPLETO', '3.30'],
      ['SALA·COMEDOR·COCINA', '22.30'],
    ];
    panel += el('text', { x: cax, y: cay, fill: ink, 'font-size': 14, 'font-family': 'var(--fl)', 'font-weight': 700, 'letter-spacing': '1.5' }, 'CUADRO DE ÁREAS');
    panel += el('line', { x1: cax, y1: cay + 8, x2: cax + caw, y2: cay + 8, stroke: ink, 'stroke-width': 1.2 });
    let ry = cay + 30;
    rowsData.forEach((r, i) => {
      panel += el('text', { x: cax + 2, y: ry, fill: ink, 'font-size': 12.5, 'font-family': 'var(--fl)', 'letter-spacing': '0.3' }, r[0]);
      panel += el('text', { x: cax + caw, y: ry, 'text-anchor': 'end', fill: ink, 'font-size': 12.5, 'font-family': 'var(--fl)', 'font-weight': 600 }, r[1]);
      panel += el('line', { x1: cax, y1: ry + 7, x2: cax + caw, y2: ry + 7, stroke: ink, 'stroke-width': 0.4, opacity: 0.3 });
      ry += 26;
    });
    panel += el('line', { x1: cax, y1: ry - 3, x2: cax + caw, y2: ry - 3, stroke: ink, 'stroke-width': 1.2 });
    panel += el('text', { x: cax + 2, y: ry + 16, fill: ink, 'font-size': 13, 'font-family': 'var(--fl)', 'font-weight': 700, 'letter-spacing': '0.5' }, 'TOTAL ÚTIL');
    panel += el('text', { x: cax + caw, y: ry + 16, 'text-anchor': 'end', fill: ink, 'font-size': 13, 'font-family': 'var(--fl)', 'font-weight': 700 }, '51.40 m²');
    ry += 38;
    panel += el('text', { x: cax + 2, y: ry, fill: ink, 'font-size': 11.5, 'font-family': 'var(--fl)', opacity: 0.7 }, 'Sup. eje a eje');
    panel += el('text', { x: cax + caw, y: ry, 'text-anchor': 'end', fill: ink, 'font-size': 11.5, 'font-family': 'var(--fl)', opacity: 0.7 }, '57.80 m²');
    ry += 20;
    panel += el('text', { x: cax + 2, y: ry, fill: ink, 'font-size': 11.5, 'font-family': 'var(--fl)', opacity: 0.7 }, 'Porche cubierto');
    panel += el('text', { x: cax + caw, y: ry, 'text-anchor': 'end', fill: ink, 'font-size': 11.5, 'font-family': 'var(--fl)', opacity: 0.7 }, '17.40 m²');

    // escala gráfica
    const sx = RX, sy = 760, unit = PPM; // 1m
    panel += el('text', { x: sx, y: sy - 12, fill: ink, 'font-size': 11.5, 'font-family': 'var(--fl)', 'letter-spacing': '1', 'font-weight': 600 }, 'ESCALA GRÁFICA  (m)');
    for (let i = 0; i < 5; i++) {
      panel += el('rect', { x: sx + i * unit * 0.5, y: sy, width: unit * 0.5, height: 8, fill: i % 2 ? theme.paper : ink, stroke: ink, 'stroke-width': 0.8 });
    }
    [0, 1, 2].forEach((m) => panel += el('text', { x: sx + m * unit, y: sy + 22, 'text-anchor': 'middle', fill: ink, 'font-size': 10.5, 'font-family': 'var(--fl)' }, m));
    g += el('g', {}, panel);

    // separador vertical panel
    g += el('line', { x1: RX - 18, y1: 150, x2: RX - 18, y2: 800, stroke: ink, 'stroke-width': 0.6, opacity: 0.25 });

    // ============================================================
    //  MEMBRETE (title block)
    // ============================================================
    const tbY = 828, tbH = 162;
    let tb = '';
    tb += el('line', { x1: 40, y1: tbY, x2: W - 24, y2: tbY, stroke: ink, 'stroke-width': 1.4 });
    tb += el('text', { x: 40, y: tbY + 34, fill: ink, 'font-size': 26, 'font-family': 'var(--fl)', 'font-weight': 700, 'letter-spacing': '2' }, 'AURUM');
    tb += el('text', { x: 40, y: tbY + 52, fill: ink, 'font-size': 12, 'font-family': 'var(--fl)', 'letter-spacing': '5', opacity: 0.7 }, 'ARQUITECTOS');
    tb += el('line', { x1: 40, y1: tbY + 66, x2: 220, y2: tbY + 66, stroke: ink, 'stroke-width': 0.6, opacity: 0.4 });
    tb += el('text', { x: 40, y: tbY + 92, fill: ink, 'font-size': 11.5, 'font-family': 'var(--fl)', opacity: 0.65, 'letter-spacing': '0.5' }, 'PROYECTO');
    tb += el('text', { x: 40, y: tbY + 110, fill: ink, 'font-size': 15, 'font-family': 'var(--fl)', 'font-weight': 600 }, 'Vivienda Unifamiliar');
    tb += el('text', { x: 40, y: tbY + 136, fill: ink, 'font-size': 11.5, 'font-family': 'var(--fl)', opacity: 0.65, 'letter-spacing': '0.5' }, 'CONTENIDO');
    tb += el('text', { x: 40, y: tbY + 154, fill: ink, 'font-size': 13, 'font-family': 'var(--fl)', 'font-weight': 500 }, 'Planta Arquitectónica');

    // columna central membrete
    const c2 = 460;
    tb += el('line', { x1: c2 - 20, y1: tbY, x2: c2 - 20, y2: tbY + tbH, stroke: ink, 'stroke-width': 0.6, opacity: 0.3 });
    const tbField = (x, y, k, v, big) => el('text', { x, y, fill: ink, 'font-size': 11, 'font-family': 'var(--fl)', opacity: 0.65, 'letter-spacing': '0.5' }, k) + el('text', { x, y: y + 18, fill: ink, 'font-size': big ? 16 : 13, 'font-family': 'var(--fl)', 'font-weight': big ? 700 : 500 }, v);
    tb += tbField(c2, tbY + 34, 'ESCALA', '1 : 75');
    tb += tbField(c2, tbY + 80, 'FECHA', '2026');
    tb += tbField(c2, tbY + 126, 'NIVEL', 'Planta Baja');

    const c3 = 640;
    tb += el('line', { x1: c3 - 20, y1: tbY, x2: c3 - 20, y2: tbY + tbH, stroke: ink, 'stroke-width': 0.6, opacity: 0.3 });
    tb += tbField(c3, tbY + 34, 'ÁREA ÚTIL', '51.40 m²');
    tb += tbField(c3, tbY + 80, 'EJES', 'A–E / 1–6');
    tb += tbField(c3, tbY + 126, 'MUROS', 'e = ' + Math.round(T * 100) + ' cm');

    // plano number box (derecha)
    const pbx = W - 200, pbw = 176;
    tb += el('rect', { x: pbx, y: tbY + 14, width: pbw, height: tbH - 28, fill: 'none', stroke: ink, 'stroke-width': 1 });
    tb += el('text', { x: pbx + pbw / 2, y: tbY + 44, 'text-anchor': 'middle', fill: ink, 'font-size': 11, 'font-family': 'var(--fl)', opacity: 0.6, 'letter-spacing': '2' }, 'PLANO');
    tb += el('text', { x: pbx + pbw / 2, y: tbY + 100, 'text-anchor': 'middle', fill: ink, 'font-size': 46, 'font-family': 'var(--fl)', 'font-weight': 700, 'letter-spacing': '2' }, 'A-01');
    tb += el('text', { x: pbx + pbw / 2, y: tbY + 130, 'text-anchor': 'middle', fill: ink, 'font-size': 11, 'font-family': 'var(--fl)', opacity: 0.6 }, 'PLANTA GENERAL');
    g += el('g', {}, tb);

    return el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, xmlns: 'http://www.w3.org/2000/svg', style: `font-family:var(--fl);display:block` }, g);
  }

  // ---- temas ----
  const THEMES = {
    clasico: {
      name: 'A · Clásico B/N', paper: '#ffffff', wall: '#16181d', ink: '#16181d',
      grid: '#d8dadf', hatchPorche: true,
      fill: { social: '#ffffff', porche: '#ffffff', principal: '#ffffff', camila: '#ffffff', bano: '#ffffff' },
    },
    grisColor: {
      name: 'B · Muros grises + color', paper: '#fbfaf8', wall: '#6f7177', ink: '#3a3c42',
      grid: '#e4e2dd', hatchPorche: false,
      fill: { social: '#f5efe3', porche: '#eceae4', principal: '#e7eef5', camila: '#f1eaf4', bano: '#e2efed' },
    },
    negroColor: {
      name: 'C · Muros negros + color', paper: '#ffffff', wall: '#16181d', ink: '#16181d',
      grid: '#e0e2e6', hatchPorche: false,
      fill: { social: '#f6f1e6', porche: '#efede8', principal: '#e6eef6', camila: '#f2ebf6', bano: '#e3f0ee' },
    },
  };

  window.PlanRender = { renderPlan, THEMES, GEOMETRY: { WALLS, DOORS, WINDOWS, SLIDERS, CLOSETS, ROOMS } };
})();
