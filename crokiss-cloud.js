/***** CroKiss — Adaptador de nube (cliente) *********************************
 * Mantiene tu editor "offline-first":
 *   - el navegador sigue guardando AL INSTANTE en localStorage (no se toca)
 *   - este adaptador sincroniza a Google Sheets (vía Apps Script) CON RETARDO
 *   - identidad de un proyecto = correo + clave; abrir por link = ?open=ID
 *
 * >>> PEGA TU URL /exec EN CONFIG.ENDPOINT. <<<
 ***************************************************************************/
(function () {
  'use strict';

  var CONFIG = {
    ENDPOINT: 'https://script.google.com/macros/s/AKfycbxFtuOvgTIkZehUqcJUA7rWpULGncFLDRZEEPAKLhLTr73dP7v1QdcE73g7yrGdcZyHsg/exec',  // tu Apps Script /exec
    SYNC_DEBOUNCE_MS: 2200,   // inactividad antes de subir a la nube
    POLL_MS: 1500             // cada cuánto revisa si cambió el plano
  };

  var ed = null;
  var ident = null;           // {planId, correo, clave, planName}
  var lastSeen = '';          // último geom visto (string)
  var lastPushed = '';        // último geom subido a la nube (string)
  var dirty = false;
  var busy = false;
  var syncTimer = null;

  var ID_KEY   = 'crokiss_identity_v1';
  var GEOM_KEY = 'marbel_editor_geom_v1';   // misma caché del motor

  /* ---------------- utilidades ---------------- */
  function $(id) { return document.getElementById(id); }
  function show(el) { if (el) el.removeAttribute('hidden'); }
  function hide(el) { if (el) el.setAttribute('hidden', ''); }
  function toast(m) { if (typeof window.toast === 'function') window.toast(m); else console.log('[CroKiss]', m); }
  function num(v) { return parseFloat((''+v).replace(',', '.')); }
  function geomStr() { try { return JSON.stringify(ed.getGeom()); } catch (e) { return ''; } }

  function setStatus(text, kind) {
    var el = $('ck_status'); if (!el) return;
    el.textContent = text;
    el.className = 'ck-pill' + (kind ? ' ck-pill--' + kind : '');
  }
  function loadIdent() { try { ident = JSON.parse(localStorage.getItem(ID_KEY) || 'null'); } catch (e) { ident = null; } }
  function saveIdent() { try { localStorage.setItem(ID_KEY, JSON.stringify(ident)); } catch (e) {} }
  function clientId() {
    var k = 'crokiss_client_v1', v = localStorage.getItem(k);
    if (!v) { v = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); try { localStorage.setItem(k, v); } catch (e) {} }
    return v;
  }

  /* ---------- red (sin preflight CORS: POST como text/plain) ---------- */
  function parse(r) { return r.text().then(function (t) { try { return JSON.parse(t); } catch (e) { return { ok: false, error: 'respuesta_invalida' }; } }); }
  function post(payload) {
    return fetch(CONFIG.ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(parse);
  }
  function get(params) {
    var qs = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    return fetch(CONFIG.ENDPOINT + '?' + qs).then(parse);
  }

  /* ---------------- sincronización ---------------- */
  function scheduleSync() {
    if (!ident) return;                  // sin identidad: solo local
    dirty = true;
    setStatus('Guardando…', 'saving');
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(doSync, CONFIG.SYNC_DEBOUNCE_MS);
  }
  function doSync() {
    if (!ident || busy) return;
    var snapshot = geomStr();
    if (snapshot === lastPushed) { dirty = false; setStatus('Guardado en la nube ✓', 'ok'); return; }
    busy = true;
    post({ mode: 'sync', correo: ident.correo, clave: ident.clave, client_id: clientId(), geom: ed.getGeom() })
      .then(function (res) {
        busy = false;
        if (res && res.ok) {
          lastPushed = snapshot; dirty = false;
          if (res.plan_id) { ident.planId = res.plan_id; saveIdent(); }
          setStatus('Guardado en la nube ✓', 'ok');
        } else { setStatus('Sin guardar — reintentando…', 'warn'); retry(); }
      })
      .catch(function () { busy = false; setStatus('Sin conexión — guardado local', 'warn'); retry(); });
  }
  function retry() { if (syncTimer) clearTimeout(syncTimer); syncTimer = setTimeout(doSync, 5000); }

  /* -------- detección de cambios (sin tocar el motor) -------- */
  function poll() {
    var s = geomStr();
    if (s && s !== lastSeen) { lastSeen = s; scheduleSync(); }
  }

  /* -------- guardar al cerrar/ocultar (best effort) -------- */
  function beacon() {
    if (!ident || !dirty) return;
    try {
      var blob = new Blob([JSON.stringify({ mode: 'sync', correo: ident.correo, clave: ident.clave, client_id: clientId(), geom: ed.getGeom() })], { type: 'text/plain;charset=utf-8' });
      navigator.sendBeacon(CONFIG.ENDPOINT, blob);
    } catch (e) {}
  }

  /* ---------------- terreno (onboarding) ---------------- */
  function buildLotGeom(w, d) {
    w = Math.max(1, w || 0); d = Math.max(1, d || 0);
    return {
      schemaVersion: 1,
      lot: { w: w, d: d },
      blockLen: 0.40, joint: 0.01,
      walls: [
        { id: 'w0', type: 'ext', x1: 0, y1: 0, x2: w, y2: 0, re: [] },
        { id: 'w1', type: 'ext', x1: w, y1: 0, x2: w, y2: d, re: [] },
        { id: 'w2', type: 'ext', x1: 0, y1: d, x2: w, y2: d, re: [] },
        { id: 'w3', type: 'ext', x1: 0, y1: 0, x2: 0, y2: d, re: [] }
      ],
      windows: [], doors: [], sliders: [], furniture: []
    };
  }
  function startTerrain(w, d) {
    w = num(w); d = num(d);
    if (!(w > 0) || !(d > 0)) { toast('Escribe el ancho y el fondo en metros'); return; }
    var g = buildLotGeom(w, d);
    if (ed.loadGeom(g)) {
      lastSeen = geomStr(); lastPushed = '';        // nuevo local, aún no en nube
      hide($('ck_modal_terreno'));
      setStatus('Borrador local — guarda con tu clave', 'warn');
      toast('Terreno de ' + g.lot.w + ' × ' + g.lot.d + ' m. Dibuja tus muros dentro.');
    }
  }

  /* ---------------- guardar a la nube + correo ---------------- */
  function submitSave() {
    var nombre = ($('ck_g_nombre').value || '').trim();
    var correo = ($('ck_g_correo').value || '').trim().toLowerCase();
    var clave  = ($('ck_g_clave').value  || '').trim();
    var planNm = ($('ck_g_plan').value   || '').trim() || 'Mi proyecto';
    var mkt    = $('ck_g_mkt') ? $('ck_g_mkt').checked : false;
    var honey  = $('ck_g_web') ? $('ck_g_web').value : '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) { toast('Escribe un correo válido'); return; }
    if (!clave) { toast('Elige una clave para volver a tu proyecto'); return; }

    setStatus('Guardando…', 'saving');
    post({ mode: 'save', nombre: nombre, correo: correo, clave: clave, plan_name: planNm,
           marketing: mkt, website: honey, client_id: clientId(), geom: ed.getGeom() })
      .then(function (res) {
        if (res && res.ok) {
          ident = { planId: res.plan_id, correo: correo, clave: clave, planName: planNm };
          saveIdent();
          lastPushed = geomStr(); lastSeen = lastPushed; dirty = false;
          hide($('ck_modal_guardar'));
          setStatus('Guardado en la nube ✓', 'ok');
          toast(res.emailed ? ('Guardado. Te enviamos tu clave a ' + correo) : 'Guardado en la nube ✓');
        } else if (res && res.error === 'limite_por_correo') {
          toast('Llegaste al máximo de proyectos para ese correo.'); setStatus('Borrador local', 'warn');
        } else {
          toast('No se pudo guardar. Intenta de nuevo.'); setStatus('Sin guardar', 'warn');
        }
      })
      .catch(function () {
        toast('Sin conexión. Tu plano sigue guardado en este navegador.');
        setStatus('Sin conexión — guardado local', 'warn');
      });
  }

  /* ---------------- abrir con clave ---------------- */
  function submitOpen() {
    var correo = ($('ck_a_correo').value || '').trim().toLowerCase();
    var clave  = ($('ck_a_clave').value  || '').trim();
    if (!correo || !clave) { toast('Escribe tu correo y tu clave'); return; }
    setStatus('Abriendo…', 'saving');
    get({ action: 'open', correo: correo, clave: clave })
      .then(function (res) {
        if (res && res.ok && res.geom) {
          ed.loadGeom(res.geom);
          ident = { planId: res.plan_id, correo: correo, clave: clave, planName: res.plan_name || 'Mi proyecto' };
          saveIdent();
          lastPushed = geomStr(); lastSeen = lastPushed; dirty = false;
          hide($('ck_modal_abrir')); hide($('ck_modal_terreno'));
          setStatus('Guardado en la nube ✓', 'ok');
          toast('Proyecto abierto: ' + ident.planName);
        } else {
          toast('No encontramos un proyecto con ese correo y clave.');
        }
      })
      .catch(function () { toast('Sin conexión. Inténtalo más tarde.'); });
  }

  function openById(planId) {
    setStatus('Abriendo…', 'saving');
    get({ action: 'plan', id: planId })
      .then(function (res) {
        if (res && res.ok && res.geom) {
          ed.loadGeom(res.geom);
          ident = { planId: res.plan_id || planId, correo: res.correo, clave: res.clave, planName: res.plan_name || 'Mi proyecto' };
          saveIdent();
          lastPushed = geomStr(); lastSeen = lastPushed; dirty = false;
          setStatus('Guardado en la nube ✓', 'ok');
          toast('Proyecto abierto: ' + ident.planName);
        } else { toast('Ese enlace no encontró el proyecto.'); fresh(); }
      })
      .catch(function () { toast('Sin conexión.'); });
  }

  /* ---------------- arranque ---------------- */
  function fresh() { show($('ck_modal_terreno')); }

  function wire() {
    if ($('ckSaveBtn')) $('ckSaveBtn').addEventListener('click', function () {
      if (ident) { $('ck_g_correo').value = ident.correo || ''; $('ck_g_clave').value = ident.clave || ''; $('ck_g_plan').value = ident.planName || ''; }
      show($('ck_modal_guardar'));
    });
    if ($('ckOpenBtn')) $('ckOpenBtn').addEventListener('click', function () { show($('ck_modal_abrir')); });
    if ($('ckNewBtn'))  $('ckNewBtn').addEventListener('click', function () {
      if (confirm('¿Empezar un proyecto nuevo? Guarda el actual con tu clave para no perderlo.')) show($('ck_modal_terreno'));
    });

    if ($('ck_terreno_go'))    $('ck_terreno_go').addEventListener('click', function () { startTerrain($('ck_ancho').value, $('ck_fondo').value); });
    if ($('ck_terreno_abrir')) $('ck_terreno_abrir').addEventListener('click', function (e) { e.preventDefault(); hide($('ck_modal_terreno')); show($('ck_modal_abrir')); });
    if ($('ck_presets')) $('ck_presets').addEventListener('click', function (e) {
      var b = e.target.closest('[data-w]'); if (!b) return;
      $('ck_ancho').value = b.getAttribute('data-w'); $('ck_fondo').value = b.getAttribute('data-d');
    });

    if ($('ck_g_go'))    $('ck_g_go').addEventListener('click', submitSave);
    if ($('ck_g_close')) $('ck_g_close').addEventListener('click', function () { hide($('ck_modal_guardar')); });
    if ($('ck_a_go'))    $('ck_a_go').addEventListener('click', submitOpen);
    if ($('ck_a_close')) $('ck_a_close').addEventListener('click', function () { hide($('ck_modal_abrir')); });

    ['ck_modal_guardar', 'ck_modal_abrir'].forEach(function (id) {   // clic fuera = cerrar
      var ov = $(id); if (!ov) return;
      ov.addEventListener('click', function (e) { if (e.target === ov) hide(ov); });
    });
  }

  function boot(editor) {
    ed = editor;
    loadIdent();
    wire();

    var openId = new URLSearchParams(location.search).get('open');

    if (openId) {
      openById(openId);
    } else if (ident) {
      lastSeen = geomStr(); lastPushed = '';
      setStatus('Guardado en la nube ✓', 'ok');
      scheduleSync();                       // sube cambios locales pendientes de la sesión pasada
    } else if (localStorage.getItem(GEOM_KEY)) {
      lastSeen = geomStr();
      setStatus('Borrador local — guarda con tu clave', 'warn');
    } else {
      setStatus('Borrador local', 'warn');
      fresh();                              // visitante nuevo → pedir terreno
    }

    setInterval(poll, CONFIG.POLL_MS);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') beacon(); });
    window.addEventListener('pagehide', beacon);
  }

  window.CroKiss = { boot: boot, startTerrain: startTerrain };
})();
