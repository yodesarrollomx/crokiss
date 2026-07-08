/* ============================================================
   Biblioteca de mobiliario — símbolos de línea fina
   Cada draw() dibuja centrado en (0,0), abarcando
   [-wpx/2,-hpx/2] .. [wpx/2,hpx/2]. Monocromático.
   "Frente"/cabecera apunta hacia -y (arriba) sin rotar.
   ============================================================ */
(function () {
  'use strict';

  function el(tag, attrs, inner) {
    let s = '<' + tag;
    for (const k in attrs) s += ' ' + k + '="' + attrs[k] + '"';
    s += inner != null ? '>' + inner + '</' + tag + '>' : '/>';
    return s;
  }

  // catálogo: medidas por defecto (m) y etiqueta
  const CATALOG = {
    cama_matrimonial: { label: 'Cama matrimonial', w: 1.60, h: 2.00, group: 'Recámara' },
    cama_individual:  { label: 'Cama individual',  w: 1.00, h: 1.90, group: 'Recámara' },
    buro:             { label: 'Buró',             w: 0.50, h: 0.45, group: 'Recámara' },
    closet:           { label: 'Clóset',           w: 1.80, h: 0.60, group: 'Recámara' },
    sofa:             { label: 'Sofá',             w: 2.10, h: 0.90, group: 'Sala' },
    sillon:           { label: 'Sillón',           w: 0.90, h: 0.90, group: 'Sala' },
    mesa_centro:      { label: 'Mesa de centro',   w: 1.10, h: 0.60, group: 'Sala' },
    mueble_tv:        { label: 'Mueble TV',        w: 1.60, h: 0.45, group: 'Sala' },
    barra:            { label: 'Barra / cubierta', w: 2.40, h: 0.60, group: 'Cocina' },
    estufa:           { label: 'Estufa',           w: 0.60, h: 0.60, group: 'Cocina' },
    tarja:            { label: 'Tarja',            w: 0.80, h: 0.60, group: 'Cocina' },
    refri:            { label: 'Refrigerador',     w: 0.70, h: 0.70, group: 'Cocina' },
    wc:               { label: 'WC',               w: 0.40, h: 0.70, group: 'Baño' },
    lavabo:           { label: 'Lavabo',           w: 0.60, h: 0.50, group: 'Baño' },
    tina:             { label: 'Tina',             w: 1.70, h: 0.75, group: 'Baño' },
    regadera:         { label: 'Regadera',         w: 0.90, h: 0.90, group: 'Baño' },
    lavadora:         { label: 'Lavadora',         w: 0.65, h: 0.65, group: 'Cocina' },
    escalera:         { label: 'Escalera',         w: 1.00, h: 2.60, group: 'Otros' },
    auto:             { label: 'Auto (cochera)',   w: 2.40, h: 5.00, group: 'Otros' },
    mesa_comedor:     { label: 'Mesa comedor',     w: 1.40, h: 0.90, group: 'Otros' },
  };

  // helper: rect redondeado centrado
  function rrect(w, h, r, attrs) {
    return el('rect', Object.assign({ x: -w / 2, y: -h / 2, width: w, height: h, rx: r, ry: r }, attrs));
  }

  // dibuja el símbolo; w,h en px. st=color, sw=grosor
  function draw(type, w, h, st, sw) {
    const A = { fill: 'none', stroke: st, 'stroke-width': sw, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
    const hw = w / 2, hh = h / 2;
    let s = '';
    switch (type) {
      case 'cama_matrimonial':
      case 'cama_individual': {
        s += rrect(w, h, Math.min(w, h) * 0.06, A);
        // línea de edredón (~38% desde la cabecera, arriba=-y)
        const yFold = -hh + h * 0.34;
        s += el('line', { x1: -hw, y1: yFold, x2: hw, y2: yFold, stroke: st, 'stroke-width': sw });
        // almohadas
        const pad = Math.min(w, h) * 0.07, ph = h * 0.16;
        if (type === 'cama_matrimonial') {
          const pw = w / 2 - pad * 1.5;
          s += rrect(0, 0, 0, {}); // noop
          s += el('rect', { x: -hw + pad, y: -hh + pad, width: pw, height: ph, rx: ph * 0.3, fill: 'none', stroke: st, 'stroke-width': sw });
          s += el('rect', { x: pad / 2, y: -hh + pad, width: pw, height: ph, rx: ph * 0.3, fill: 'none', stroke: st, 'stroke-width': sw });
        } else {
          s += el('rect', { x: -hw + pad, y: -hh + pad, width: w - pad * 2, height: ph, rx: ph * 0.3, fill: 'none', stroke: st, 'stroke-width': sw });
        }
        break;
      }
      case 'buro':
        s += rrect(w, h, 1.5, A);
        s += el('line', { x1: -hw, y1: hh - h * 0.32, x2: hw, y2: hh - h * 0.32, stroke: st, 'stroke-width': sw * 0.8 });
        break;
      case 'closet':
        s += rrect(w, h, 1, A);
        s += el('line', { x1: -hw, y1: -hh + h * 0.34, x2: hw, y2: -hh + h * 0.34, stroke: st, 'stroke-width': sw * 0.8 });
        // riel de puertas (líneas verticales suaves)
        for (let i = 1; i < 4; i++) s += el('line', { x1: -hw + (w * i) / 4, y1: -hh + h * 0.34, x2: -hw + (w * i) / 4, y2: hh, stroke: st, 'stroke-width': sw * 0.6, opacity: 0.6 });
        break;
      case 'sofa': {
        const back = h * 0.26, arm = w * 0.10;
        s += rrect(w, h, h * 0.12, A);
        // respaldo (arriba)
        s += el('line', { x1: -hw + arm, y1: -hh + back, x2: hw - arm, y2: -hh + back, stroke: st, 'stroke-width': sw });
        // brazos
        s += el('line', { x1: -hw + arm, y1: -hh + back, x2: -hw + arm, y2: hh, stroke: st, 'stroke-width': sw });
        s += el('line', { x1: hw - arm, y1: -hh + back, x2: hw - arm, y2: hh, stroke: st, 'stroke-width': sw });
        // cojín divisor
        s += el('line', { x1: 0, y1: -hh + back, x2: 0, y2: hh, stroke: st, 'stroke-width': sw * 0.8 });
        break;
      }
      case 'sillon': {
        const back = h * 0.26, arm = w * 0.16;
        s += rrect(w, h, h * 0.14, A);
        s += el('line', { x1: -hw + arm, y1: -hh + back, x2: hw - arm, y2: -hh + back, stroke: st, 'stroke-width': sw });
        s += el('line', { x1: -hw + arm, y1: -hh + back, x2: -hw + arm, y2: hh, stroke: st, 'stroke-width': sw });
        s += el('line', { x1: hw - arm, y1: -hh + back, x2: hw - arm, y2: hh, stroke: st, 'stroke-width': sw });
        break;
      }
      case 'mesa_centro':
        s += rrect(w, h, Math.min(w, h) * 0.12, A);
        break;
      case 'mueble_tv':
        s += rrect(w, h, 1, A);
        s += el('line', { x1: -hw, y1: 0, x2: hw, y2: 0, stroke: st, 'stroke-width': sw * 0.7 });
        break;
      case 'barra':
        s += el('rect', { x: -hw, y: -hh, width: w, height: h, fill: 'none', stroke: st, 'stroke-width': sw });
        // borde de cubierta
        s += el('rect', { x: -hw + 2, y: -hh + 2, width: w - 4, height: h - 4, fill: 'none', stroke: st, 'stroke-width': sw * 0.6, opacity: 0.55 });
        break;
      case 'estufa':
        s += el('rect', { x: -hw, y: -hh, width: w, height: h, fill: 'none', stroke: st, 'stroke-width': sw });
        const rr = Math.min(w, h) * 0.16;
        [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => s += el('circle', { cx: sx * w * 0.24, cy: sy * h * 0.24, r: rr, fill: 'none', stroke: st, 'stroke-width': sw * 0.8 }));
        break;
      case 'tarja':
        s += el('rect', { x: -hw, y: -hh, width: w, height: h, fill: 'none', stroke: st, 'stroke-width': sw });
        s += el('rect', { x: -hw + w * 0.12, y: -hh + h * 0.18, width: w * 0.76, height: h * 0.5, rx: 2, fill: 'none', stroke: st, 'stroke-width': sw * 0.8 });
        s += el('circle', { cx: 0, cy: -hh + h * 0.43, r: Math.min(w, h) * 0.05, fill: 'none', stroke: st, 'stroke-width': sw * 0.7 });
        s += el('circle', { cx: 0, cy: hh - h * 0.12, r: Math.min(w, h) * 0.05, fill: 'none', stroke: st, 'stroke-width': sw * 0.7 });
        break;
      case 'refri':
        s += rrect(w, h, 1.5, A);
        s += el('line', { x1: -hw, y1: -hh + h * 0.34, x2: hw, y2: -hh + h * 0.34, stroke: st, 'stroke-width': sw * 0.8 });
        s += el('line', { x1: -hw + w * 0.16, y1: -hh + h * 0.46, x2: -hw + w * 0.16, y2: hh - h * 0.16, stroke: st, 'stroke-width': sw * 0.8 });
        break;
      case 'wc': {
        // tanque (arriba) + taza (óvalo)
        const tankH = h * 0.24;
        s += el('rect', { x: -w * 0.42, y: -hh, width: w * 0.84, height: tankH, rx: 1.5, fill: 'none', stroke: st, 'stroke-width': sw });
        s += el('ellipse', { cx: 0, cy: -hh + tankH + (h - tankH) * 0.52, rx: w * 0.46, ry: (h - tankH) * 0.46, fill: 'none', stroke: st, 'stroke-width': sw });
        break;
      }
      case 'lavabo':
        s += rrect(w, h, 2, A);
        s += el('ellipse', { cx: 0, cy: h * 0.06, rx: w * 0.34, ry: h * 0.30, fill: 'none', stroke: st, 'stroke-width': sw * 0.85 });
        s += el('circle', { cx: 0, cy: -hh + h * 0.16, r: Math.min(w, h) * 0.05, fill: 'none', stroke: st, 'stroke-width': sw * 0.7 });
        break;
      case 'tina':
        s += rrect(w, h, h * 0.18, A);
        s += rrect(w - h * 0.36, h - h * 0.36, h * 0.14, { fill: 'none', stroke: st, 'stroke-width': sw * 0.8 });
        s += el('circle', { cx: hw - h * 0.34, cy: 0, r: Math.min(w, h) * 0.06, fill: 'none', stroke: st, 'stroke-width': sw * 0.7 });
        break;
      case 'mesa_comedor':
        s += rrect(w, h, Math.min(w, h) * 0.10, A);
        // 4 sillas (líneas en cada lado)
        s += el('line', { x1: -w * 0.28, y1: -hh - 5, x2: w * 0.28, y2: -hh - 5, stroke: st, 'stroke-width': sw * 0.8 });
        s += el('line', { x1: -w * 0.28, y1: hh + 5, x2: w * 0.28, y2: hh + 5, stroke: st, 'stroke-width': sw * 0.8 });
        break;
      case 'regadera': {
        s += el('rect', { x: -hw, y: -hh, width: w, height: h, fill: 'none', stroke: st, 'stroke-width': sw });
        s += el('line', { x1: -hw, y1: -hh, x2: hw, y2: hh, stroke: st, 'stroke-width': sw * 0.6, opacity: 0.5 });
        s += el('line', { x1: hw, y1: -hh, x2: -hw, y2: hh, stroke: st, 'stroke-width': sw * 0.6, opacity: 0.5 });
        s += el('circle', { cx: -hw + w * 0.16, cy: -hh + h * 0.16, r: Math.min(w, h) * 0.08, fill: 'none', stroke: st, 'stroke-width': sw * 0.8 });
        break;
      }
      case 'lavadora':
        s += rrect(w, h, 2, A);
        s += el('circle', { cx: 0, cy: h * 0.04, r: Math.min(w, h) * 0.32, fill: 'none', stroke: st, 'stroke-width': sw * 0.85 });
        s += el('line', { x1: -hw, y1: -hh + h * 0.24, x2: hw, y2: -hh + h * 0.24, stroke: st, 'stroke-width': sw * 0.7 });
        break;
      case 'escalera': {
        s += el('rect', { x: -hw, y: -hh, width: w, height: h, fill: 'none', stroke: st, 'stroke-width': sw });
        const n = 9;
        for (let i = 1; i < n; i++) s += el('line', { x1: -hw, y1: -hh + (h * i) / n, x2: hw, y2: -hh + (h * i) / n, stroke: st, 'stroke-width': sw * 0.7 });
        s += el('line', { x1: 0, y1: -hh, x2: 0, y2: hh, stroke: st, 'stroke-width': sw * 0.6, opacity: 0.5 });
        break;
      }
      case 'auto':
        s += rrect(w, h, Math.min(w, h) * 0.18, A);
        s += rrect(w * 0.7, h * 0.34, Math.min(w, h) * 0.1, { fill: 'none', stroke: st, 'stroke-width': sw * 0.7, opacity: 0.7 });
        break;
      default:
        s += rrect(w, h, 2, A);
    }
    return s;
  }

  window.PlanFurniture = { CATALOG, draw };
})();
