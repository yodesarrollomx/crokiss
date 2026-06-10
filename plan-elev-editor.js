/* =============================================================
   CroKiss — Editor de fachadas (plan-elev-editor.js)
   Overlay interactivo para ver las 4 fachadas (PlanElev.facade)
   y editar las alturas del proyecto (geom.elev) y los overrides
   por vano (vano.z) con clic directo sobre la fachada.
   Todos los cambios pasan por el editor de planos para entrar al
   deshacer normal y a la persistencia:
     ed.updateElev(patch)                — alturas del proyecto
     ed.updateVanoZ(kind, id, z | null)  — override por vano
   API:  PlanElevEditor.open(ed)   ← botón "Fachadas"
   ============================================================= */
(function () {
  'use strict';

  var ACENTO = '#c75b39', PPM = 74;
  var DIRS = ['S', 'N', 'E', 'O'];
  var TABS = { S: 'SUR', N: 'NORTE', E: 'ORIENTE', O: 'PONIENTE' };
  var DEF = { hMuro: 2.40, antepecho: 0.90, dintel: 2.10, cubierta: 'losa', pretil: 0.35 };

  var edRef = null, ov = null, dirAct = 'S', selVano = null;   // selVano = {kind,id}

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  var r2 = function (v) { return Math.round(v * 100) / 100; };
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function num(inputId, def) {
    var el = document.getElementById(inputId);
    var v = parseFloat(el && el.value);
    return isNaN(v) ? def : v;
  }

  /* ---------- estilos (una sola vez) ---------- */
  function ensureStyle() {
    if (document.getElementById('ck_elevedit_css')) return;
    var st = document.createElement('style');
    st.id = 'ck_elevedit_css';
    st.textContent =
      '#ck_elevedit{position:fixed;inset:0;background:#efece6;z-index:210;display:flex;flex-direction:column;font-family:Saira Semi Condensed,Arial,sans-serif;}' +
      '#ck_elevedit .fe-bar{display:flex;gap:10px;align-items:center;padding:10px 16px;background:#16181d;color:#fbfaf8;font-size:13.5px;flex-wrap:wrap;}' +
      '#ck_elevedit .fe-bar .sp{flex:1;}' +
      '#ck_elevedit .fe-tabs{display:flex;gap:6px;flex-wrap:wrap;}' +
      '#ck_elevedit .fe-tabs button{font-family:inherit;font-size:12.5px;letter-spacing:.06em;padding:7px 13px;border-radius:8px;border:1px solid rgba(255,255,255,.3);background:transparent;color:#fbfaf8;cursor:pointer;}' +
      '#ck_elevedit .fe-tabs button.on{background:#fbfaf8;color:#16181d;font-weight:600;}' +
      '#ck_elevedit .fe-tabs button:disabled{opacity:.35;cursor:default;}' +
      '#ck_elevedit .fe-body{flex:1;display:flex;min-height:0;}' +
      '#ck_elevedit .fe-view{flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;padding:20px;min-width:0;}' +
      '#ck_elevedit .fe-stage{background:#fff;border:1px solid #d8d5cd;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.12);padding:14px;width:min(1280px,100%);display:flex;flex-direction:column;}' +
      /* B2: el svg llena el ancho disponible (sin esto cae al default 300×150 px) */
      '#ck_elevedit .fe-stage svg{display:block;width:100%;height:auto;max-height:64vh;}' +
      '#ck_elevedit .fe-stage h4{margin:8px 4px 0;font-size:13px;letter-spacing:.12em;color:#16181d;}' +
      '#ck_elevedit .fe-stage .fe-meta{margin:3px 4px 0;font-size:11.5px;color:#6b6256;letter-spacing:.03em;}' +
      '#ck_elevedit .fe-stage .fe-avisos{margin:3px 4px 0;font-size:11.5px;color:#854f0b;}' +
      '#ck_elevedit .fe-stage [data-kind]{cursor:pointer;}' +
      '#ck_elevedit .fe-stage [data-kind]:hover{opacity:.82;}' +
      '#ck_elevedit .fe-empty{color:#6b6256;font-size:14px;max-width:420px;line-height:1.5;text-align:center;}' +
      '#ck_elevedit .fe-side{width:300px;flex:none;background:#fbfaf8;border-left:1px solid #d8d5cd;overflow:auto;padding:16px 18px;}' +
      '#ck_elevedit .fe-side h3{margin:2px 0 10px;font-size:13px;letter-spacing:.1em;color:#16181d;border-bottom:2px solid ' + ACENTO + ';padding-bottom:6px;}' +
      '#ck_elevedit .fe-side .campo{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:9px 0;font-size:13px;color:#3c3a37;}' +
      '#ck_elevedit .fe-side input,#ck_elevedit .fe-side select{font-family:inherit;font-size:13px;padding:5px 7px;border:1px solid #c9c4ba;border-radius:7px;width:96px;background:#fff;}' +
      '#ck_elevedit .fe-side select{width:140px;}' +
      '#ck_elevedit .fe-sel{margin-top:18px;padding:12px 14px;border:1.5px solid ' + ACENTO + ';border-radius:10px;background:#fff;}' +
      '#ck_elevedit .fe-stats{margin-top:18px;padding:10px 12px;border:1px solid #d8d5cd;border-radius:10px;background:#fff;font-size:12.5px;color:#3c3a37;line-height:1.7;}' +
      '#ck_elevedit .fe-sel .pista{font-size:12px;color:#6b6256;margin:6px 0 10px;}' +
      '#ck_elevedit .fe-sel .tag{display:inline-block;background:' + ACENTO + ';color:#fff;font-size:11.5px;letter-spacing:.06em;padding:2px 9px;border-radius:99px;margin-bottom:8px;}' +
      '#ck_elevedit .fe-side button{font-family:inherit;font-size:12.5px;padding:7px 11px;border-radius:8px;border:1px solid #c9c4ba;background:#fff;color:#16181d;cursor:pointer;}' +
      '#ck_elevedit .fe-side button:disabled{opacity:.4;cursor:default;}' +
      '#ck_elevedit .fe-foot{display:flex;gap:10px;align-items:center;padding:10px 16px;background:#16181d;color:#fbfaf8;font-size:12.5px;flex-wrap:wrap;}' +
      '#ck_elevedit .fe-foot .sp{flex:1;}' +
      '#ck_elevedit .fe-foot button{font-family:inherit;font-size:13px;padding:8px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.3);background:transparent;color:#fbfaf8;cursor:pointer;}' +
      '#ck_elevedit .fe-foot button.acc{background:' + ACENTO + ';border-color:' + ACENTO + ';font-weight:600;}';
    document.head.appendChild(st);
  }

  /* ---------- datos vivos ---------- */
  function geom() { return edRef.getGeom(); }
  function elev() {
    var e = geom().elev || {};
    return {
      hMuro: typeof e.hMuro === 'number' ? e.hMuro : DEF.hMuro,
      antepecho: typeof e.antepecho === 'number' ? e.antepecho : DEF.antepecho,
      dintel: typeof e.dintel === 'number' ? e.dintel : DEF.dintel,
      cubierta: e.cubierta || DEF.cubierta,
      pretil: typeof e.pretil === 'number' ? e.pretil : DEF.pretil
    };
  }
  function findVano(kind, id) {
    var g = geom();
    var arr = kind === 'window' ? g.windows : kind === 'slider' ? g.sliders : g.doors;
    return (arr || []).filter(function (o) { return o.id === id; })[0] || null;
  }

  /* ---------- vista de la fachada activa ---------- */
  function renderTabs() {
    DIRS.forEach(function (d) {
      var b = document.getElementById('fe_tab_' + d);
      if (!b) return;
      var f = window.PlanElev ? PlanElev.facade(geom(), d) : null;
      b.disabled = !f;
      // pestaña informativa: número de vanos y bandera de avisos del modelo
      b.innerHTML = TABS[d] + (f ? ' · ' + f.stats.nVanos + (f.avisos.length ? ' ⚠' : '') : '');
      b.classList.toggle('on', d === dirAct);
    });
  }

  var NOMBRES = { window: 'Ventana', slider: 'Corrediza', door: 'Puerta' };

  function renderView() {
    var view = ov.querySelector('.fe-view');
    // el resaltado y las cotas vivas los dibuja el propio motor de fachadas
    var f = window.PlanElev ? PlanElev.facade(geom(), dirAct, { textos: true, resaltar: selVano }) : null;
    if (!f) {
      view.innerHTML = '<div class="fe-empty">Esta orientación aún no tiene muros.<br>' +
        'Dibuja en la planta un muro que dé hacia este lado y su fachada aparecerá aquí automáticamente.</div>';
      return;
    }
    // viewBox con holgura para niveles (izquierda) y cota de alturas (derecha)
    var w = f.widthM * PPM, h = f.heightM * PPM;
    var vbX = -155, vbW = w + 155 + 115, vbY = -16, vbH = h + 34;
    view.innerHTML =
      '<div class="fe-stage">' +
        '<svg id="fe_svg" viewBox="' + vbX + ' ' + vbY + ' ' + vbW + ' ' + vbH + '" ' +
          'width="' + Math.round(vbW / 2) + '" height="' + Math.round(vbH / 2) + '">' + f.svg + '</svg>' +
        '<h4>' + esc(f.label) + (selVano ? ' · ' + (NOMBRES[selVano.kind] || '') + ' seleccionada' : '') + '</h4>' +
        '<div class="fe-meta">Muro ' + f.stats.muroM2 + ' m² · vanos ' + f.stats.vanoM2 + ' m² · ' +
          f.stats.pctHuecos + '% de huecos</div>' +
        (f.avisos.length ? '<div class="fe-avisos">⚠ ' + f.avisos.map(esc).join(' · ') + '</div>' : '') +
      '</div>';

    // selección por clic: figura con data-kind/data-id selecciona, fondo deselecciona
    view.querySelector('.fe-stage').addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('[data-kind]') : null;
      if (t) selVano = { kind: t.getAttribute('data-kind'), id: t.getAttribute('data-id') };
      else selVano = null;
      renderView(); renderSide();
    });
  }

  /* ---------- panel lateral ---------- */
  function campoNum(id, label, val, min, max, step) {
    return '<label class="campo">' + label +
      '<input type="number" id="' + id + '" value="' + r2(val) + '" min="' + min + '" max="' + max + '" step="' + step + '"></label>';
  }

  function renderSide() {
    var e = elev();
    var side = ov.querySelector('.fe-side');
    var h = '<h3>ALTURAS DEL PROYECTO</h3>';
    h += campoNum('fe_hmuro', 'Altura de muro (m)', e.hMuro, 2.0, 4.5, 0.05);
    h += campoNum('fe_antep', 'Antepecho de ventanas (m)', e.antepecho, 0, 2, 0.05);
    h += campoNum('fe_dintel', 'Cerramiento / dintel (m)', e.dintel, 1.8, 3.5, 0.05);
    h += '<label class="campo">Cubierta<select id="fe_cub">' +
      '<option value="losa"' + (e.cubierta === 'losa' ? ' selected' : '') + '>Losa con pretil</option>' +
      '<option value="sin"' + (e.cubierta === 'sin' ? ' selected' : '') + '>Sin pretil</option>' +
      '</select></label>';
    if (e.cubierta === 'losa') h += campoNum('fe_pretil', 'Altura de pretil (m)', e.pretil, 0.1, 1.2, 0.05);

    // panel del elemento seleccionado
    var o = selVano ? findVano(selVano.kind, selVano.id) : null;
    if (o) {
      h += '<div class="fe-sel"><h3>ESTE ELEMENTO</h3>';
      h += '<span class="tag">' + NOMBRES[selVano.kind] + ' · ' + esc(o.id) + '</span>';
      if (selVano.kind === 'window') {
        var ant = (o.z && o.z.antepecho != null) ? o.z.antepecho : e.antepecho;
        var alto = (o.z && o.z.alto != null) ? o.z.alto : Math.max(0.2, e.dintel - ant);
        h += campoNum('fe_v_antep', 'Antepecho propio (m)', ant, 0, 2, 0.05);
        h += campoNum('fe_v_alto', 'Alto propio (m)', alto, 0.2, 3, 0.05);
      } else {
        var altoP = (o.z && o.z.alto != null) ? o.z.alto : e.dintel;
        h += campoNum('fe_v_alto', 'Alto propio (m)', altoP, 0.5, 3.5, 0.05);
      }
      h += '<div class="pista">' + (o.z ? 'Este vano usa alturas propias.' : 'Este vano usa las alturas del proyecto.') + '</div>';
      h += '<button id="fe_v_reset"' + (o.z ? '' : ' disabled') + '>Usar alturas del proyecto</button>';
      h += '</div>';
    } else {
      h += '<div class="fe-sel"><div class="pista">Haz clic en una ventana, puerta o corrediza de la fachada para darle alturas propias.</div></div>';
    }
    side.innerHTML = h;

    // ---- listeners de alturas del proyecto (ed.updateElev → deshacer normal) ----
    function patchElev(patch) { edRef.updateElev(patch); refresh(); }
    document.getElementById('fe_hmuro').addEventListener('change', function () {
      patchElev({ hMuro: clamp(num('fe_hmuro', e.hMuro), 2.0, 4.5) });
    });
    document.getElementById('fe_antep').addEventListener('change', function () {
      patchElev({ antepecho: clamp(num('fe_antep', e.antepecho), 0, 2) });
    });
    document.getElementById('fe_dintel').addEventListener('change', function () {
      patchElev({ dintel: clamp(num('fe_dintel', e.dintel), 1.8, 3.5) });
    });
    document.getElementById('fe_cub').addEventListener('change', function (ev2) {
      patchElev({ cubierta: ev2.target.value === 'sin' ? 'sin' : 'losa' });
    });
    var inPretil = document.getElementById('fe_pretil');
    if (inPretil) inPretil.addEventListener('change', function () {
      patchElev({ pretil: clamp(num('fe_pretil', e.pretil), 0.1, 1.2) });
    });

    // ---- listeners del elemento seleccionado (ed.updateVanoZ) ----
    if (o) {
      function patchVano() {
        var z;
        if (selVano.kind === 'window') {
          z = { antepecho: clamp(num('fe_v_antep', e.antepecho), 0, 2),
                alto: clamp(num('fe_v_alto', 1.2), 0.2, 3) };
        } else {
          z = { alto: clamp(num('fe_v_alto', e.dintel), 0.5, 3.5) };
        }
        edRef.updateVanoZ(selVano.kind, selVano.id, z);
        refresh();
      }
      var inAnt = document.getElementById('fe_v_antep');
      if (inAnt) inAnt.addEventListener('change', patchVano);
      document.getElementById('fe_v_alto').addEventListener('change', patchVano);
      document.getElementById('fe_v_reset').addEventListener('click', function () {
        edRef.updateVanoZ(selVano.kind, selVano.id, null);   // null elimina el override
        refresh();
      });
    }
  }

  function refresh() { renderTabs(); renderView(); renderSide(); }

  /* ---------- apertura / cierre ---------- */
  function close() {
    if (ov) { ov.remove(); ov = null; }
    document.removeEventListener('keydown', onEsc, true);
    selVano = null;
  }
  function onEsc(ev) {
    // captura: el Esc del editor de planos (cancelar colocación) no debe dispararse
    if (ev.key === 'Escape' && ov) { ev.stopPropagation(); ev.preventDefault(); close(); }
  }

  function open(ed) {
    edRef = ed || edRef;
    if (!edRef || !window.PlanElev) return;
    ensureStyle();
    var old = document.getElementById('ck_elevedit'); if (old) old.remove();
    selVano = null;

    // fachada inicial: la sur, o la primera disponible
    dirAct = 'S';
    if (!PlanElev.facade(geom(), dirAct)) {
      var disp = DIRS.filter(function (d) { return !!PlanElev.facade(geom(), d); });
      if (!disp.length) return;
      dirAct = disp[0];
    }

    ov = document.createElement('div');
    ov.id = 'ck_elevedit';
    ov.innerHTML =
      '<div class="fe-bar">' +
        '<b>⌂ Fachadas</b><span style="opacity:.65">alturas y alzados del proyecto</span><span class="sp"></span>' +
        '<div class="fe-tabs">' +
          DIRS.map(function (d) { return '<button id="fe_tab_' + d + '">' + TABS[d] + '</button>'; }).join('') +
        '</div>' +
      '</div>' +
      '<div class="fe-body"><div class="fe-view"></div><div class="fe-side"></div></div>' +
      '<div class="fe-foot">' +
        '<span style="opacity:.75">Los cambios se guardan en tu proyecto y salen en la Lámina</span><span class="sp"></span>' +
        '<button id="fe_lamina" class="acc">Ver Lámina →</button>' +
        '<button id="fe_close">Cerrar</button>' +
      '</div>';
    document.body.appendChild(ov);

    DIRS.forEach(function (d) {
      document.getElementById('fe_tab_' + d).addEventListener('click', function () {
        dirAct = d; selVano = null; refresh();
      });
    });
    document.getElementById('fe_close').addEventListener('click', close);
    document.getElementById('fe_lamina').addEventListener('click', function () {
      close();
      if (window.PlanSheet) PlanSheet.open(edRef);
    });
    document.addEventListener('keydown', onEsc, true);   // captura, no choca con el Esc del editor

    refresh();
  }

  window.PlanElevEditor = { open: open };
})();
