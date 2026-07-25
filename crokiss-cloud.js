/***** CroKiss — Adaptador de nube (cliente) *********************************
 * "Offline-first": el navegador guarda al instante en localStorage y este
 * adaptador sincroniza a Google Sheets (Apps Script) con retardo.
 *
 * Modelo: correo + clave = tu cuenta; puedes tener VARIOS proyectos.
 *   - Guardar: actualiza el proyecto abierto (plan_id) o, si no hay, crea/reanuda.
 *   - Abrir con clave: si hay varios, muestra un selector para escoger.
 *   - ✦ Nuevo: empieza un proyecto nuevo (la siguiente vez que guardes se crea).
 ***************************************************************************/
(function () {
  'use strict';

  var CONFIG = {
    ENDPOINT: 'https://script.google.com/macros/s/AKfycbxFtuOvgTIkZehUqcJUA7rWpULGncFLDRZEEPAKLhLTr73dP7v1QdcE73g7yrGdcZyHsg/exec',  // tu Apps Script /exec
    SYNC_DEBOUNCE_MS: 2200,
    POLL_MS: 1500,
    // Mismo tope que el backend. Sheets no admite más de ~50.000 caracteres por
    // celda: si dejamos salir un plano más grande, el guardado revienta del otro
    // lado y el cliente se queda reintentando para siempre (lead perdido en
    // silencio). Mejor detenerlo aquí y decirlo con todas sus letras.
    MAX_GEOM_BYTES: 45000,
    CONTACT_URL: 'mailto:direccion@aurumarquitectos.com?subject=Quiero%20que%20Aurum%20revise%20mi%20croquis%20CroKiss'
  };

  var ed = null;
  var ident = null;            // {planId, correo, clave, planName}
  var lastCreds = null;        // {correo, clave} para precargar el modal de guardar
  var pendingCreds = null;     // credenciales en curso durante "abrir"
  var lastSeen = '';
  var lastPushed = '';
  var dirty = false;
  var busy = false;
  var syncTimer = null;
  var retryDelay = 5000;   // backoff exponencial de reintentos

  var ID_KEY   = 'crokiss_identity_v1';
  var GEOM_KEY = 'marbel_editor_geom_v1';   // misma caché del motor

  /* ---------------- utilidades ---------------- */
  function $(id) { return document.getElementById(id); }
  function show(el) { if (el) el.removeAttribute('hidden'); }
  function hide(el) { if (el) el.setAttribute('hidden', ''); }
  function toast(m) { if (typeof window.toast === 'function') window.toast(m); else console.log('[CroKiss]', m); }
  function num(v) { return parseFloat((''+v).replace(',', '.')); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function geomStr() { try { return JSON.stringify(ed.getGeom()); } catch (e) { return ''; } }

  // Un plano por encima del tope NO se manda: es un error permanente, así que
  // ni se postea ni se reintenta. Devuelve true si el plano es demasiado grande.
  var MSG_GRANDE = 'Tu plano es muy grande para guardarse — simplifícalo o descarga Respaldo';

  // Un error determinista merece una explicación, no un "intenta de nuevo" que
  // invita a reintentar contra algo que nunca va a funcionar.
  var ERRORES = {
    limite_por_correo:   'Llegaste al máximo de proyectos para ese correo.',
    no_autorizado:       'Ese proyecto pertenece a otra clave.',
    plano_muy_grande:    MSG_GRANDE,
    clave_corta:         'Tu clave necesita al menos 6 caracteres.',
    clave_invalida:      'Esa clave no se puede usar (máximo 40 caracteres).',
    correo_invalido:     'Revisa tu correo: no parece válido.',
    demasiados_intentos: 'Demasiados intentos. Espera unos minutos y vuelve a probar.',
    spam:                'No pudimos procesar el formulario.',
    error_interno:       'Algo falló de nuestro lado. Tu plano sigue a salvo en este navegador.'
  };
  function msgError(code) {
    return ERRORES[code] || 'No se pudo guardar. Tu plano sigue guardado en este navegador.';
  }
  function tooBig(s) {
    var n = (s == null ? geomStr() : s).length;
    return n > CONFIG.MAX_GEOM_BYTES;
  }

  function relTime(ts) {
    var d = new Date(ts); if (isNaN(d)) return '';
    var now = new Date();
    var hhmm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (d.toDateString() === now.toDateString()) return 'hoy ' + hhmm;
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'ayer ' + hhmm;
    return d.toLocaleDateString() + ' ' + hhmm;
  }

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
    if (!ident) return;                  // sin proyecto reclamado: solo local
    dirty = true;
    setStatus('Guardando…', 'saving');
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(doSync, CONFIG.SYNC_DEBOUNCE_MS);
  }
  function doSync() {
    if (!ident) return;
    if (busy) { retry(); return; }            // había un sync en vuelo: reprograma en vez de perder el cambio
    var snapshot = geomStr();
    if (snapshot === lastPushed) { dirty = false; setStatus('Guardado en la nube ✓', 'ok'); return; }
    // Tope de tamaño: error permanente, sin reintento (si no, el aviso nunca
    // se vería y el usuario creería que su plano está a salvo).
    if (tooBig(snapshot)) { setStatus(MSG_GRANDE, 'warn'); return; }
    busy = true;
    post({ mode: 'sync', plan_id: ident.planId || '', correo: ident.correo, clave: ident.clave, client_id: clientId(), geom: ed.getGeom() })
      .then(function (res) {
        busy = false;
        if (res && res.ok) {
          lastPushed = snapshot; dirty = false; retryDelay = 5000;
          if (res.plan_id) { ident.planId = res.plan_id; saveIdent(); }
          setStatus('Guardado en la nube ✓', 'ok');
          if (geomStr() !== lastPushed) scheduleSync();   // llegó un cambio mientras subíamos
        } else if (res && res.error === 'no_autorizado') {
          setStatus('Este proyecto es de otra clave — guarda como nuevo', 'warn');   // error permanente: no reintentar
        } else { setStatus('Sin guardar — reintentando…', 'warn'); retry(); }
      })
      .catch(function () { busy = false; setStatus('Sin conexión — guardado local', 'warn'); retry(); });
  }
  function retry() { if (syncTimer) clearTimeout(syncTimer); syncTimer = setTimeout(doSync, retryDelay); retryDelay = Math.min(retryDelay * 2, 60000); }

  function poll() {
    var s = geomStr();
    if (s && s !== lastSeen) { lastSeen = s; scheduleSync(); }
    maybeNudge();
  }
  function beacon() {
    if (!ident || !dirty) return;
    if (tooBig()) return;                 // no tiene caso: el backend lo rechazaría
    try {
      var blob = new Blob([JSON.stringify({ mode: 'sync', plan_id: ident.planId || '', correo: ident.correo, clave: ident.clave, client_id: clientId(), geom: ed.getGeom() })], { type: 'text/plain;charset=utf-8' });
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
      lastSeen = geomStr(); lastPushed = '';
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
    if (tooBig()) { toast(MSG_GRANDE); setStatus('Sin guardar — plano muy grande', 'warn'); return; }

    setStatus('Guardando…', 'saving');
    post({ mode: 'save', plan_id: (ident && ident.planId) || '', nombre: nombre, correo: correo, clave: clave,
           plan_name: planNm, marketing: mkt, website: honey, client_id: clientId(), geom: ed.getGeom() })
      .then(function (res) {
        if (res && res.ok) {
          ident = { planId: res.plan_id, correo: correo, clave: clave, planName: planNm };
          lastCreds = { correo: correo, clave: clave };
          saveIdent();
          lastPushed = geomStr(); lastSeen = lastPushed; dirty = false;
          hide($('ck_modal_guardar'));
          setStatus('Guardado en la nube ✓', 'ok');
          if ($('ck_nudge')) $('ck_nudge').remove();
          showSuccess(correo, clave, !!res.emailed);
        } else {
          toast(msgError(res && res.error)); setStatus('Sin guardar', 'warn');
        }
      })
      .catch(function () {
        toast('Sin conexión. Tu plano sigue guardado en este navegador.');
        setStatus('Sin conexión — guardado local', 'warn');
      });
  }

  /* ---------------- abrir con clave (lista + selector) ---------------- */
  function submitOpen() {
    var correo = ($('ck_a_correo').value || '').trim().toLowerCase();
    var clave  = ($('ck_a_clave').value  || '').trim();
    if (!correo || !clave) { toast('Escribe tu correo y tu clave'); return; }
    setStatus('Buscando…', 'saving');
    get({ action: 'list', correo: correo, clave: clave })
      .then(function (res) {
        if (!res || !res.ok) { toast('No se pudo consultar. Intenta de nuevo.'); return; }
        var items = res.items || [];
        if (items.length === 0) { toast('No encontramos proyectos con ese correo y clave.'); setStatus(ident ? 'Guardado en la nube ✓' : 'Borrador local', ident ? 'ok' : 'warn'); return; }
        pendingCreds = { correo: correo, clave: clave };
        hide($('ck_modal_abrir'));
        if (items.length === 1) { openProject(items[0].plan_id, correo, clave); return; }
        renderSelect(items);
        show($('ck_modal_select'));
        setStatus('Elige un proyecto…', 'saving');
      })
      .catch(function () { toast('Sin conexión. Inténtalo más tarde.'); });
  }

  function renderSelect(items) {
    var box = $('ck_select_list'); if (!box) return;
    box.innerHTML = items.map(function (it) {
      return '<button class="ck-proj" data-id="' + esc(it.plan_id) + '">' +
               '<span class="ck-proj-name">' + esc(it.plan_name) + '</span>' +
               '<span class="ck-proj-meta">v' + (it.version || 1) + ' · ' + esc(relTime(it.ts)) + '</span>' +
             '</button>';
    }).join('');
  }

  function openProject(planId, correo, clave) {
    setStatus('Abriendo…', 'saving');
    get({ action: 'plan', id: planId, correo: correo, clave: clave })
      .then(function (res) {
        if (res && res.ok && res.geom) {
          ed.loadGeom(res.geom);
          hide($('ck_modal_terreno')); hide($('ck_modal_select'));
          if (correo && clave) {
            // apertura autenticada: sincroniza normal
            ident = { planId: res.plan_id || planId, correo: correo, clave: clave, planName: res.plan_name || 'Mi proyecto' };
            lastCreds = { correo: correo, clave: clave };
            saveIdent();
            lastPushed = geomStr(); lastSeen = lastPushed; dirty = false;
            setStatus('Guardado en la nube ✓', 'ok');
            toast('Proyecto abierto: ' + ident.planName);
          } else {
            // vino del enlace del correo (?open=ID) SIN clave: NO fabricar identidad con credenciales vacías.
            // Se abre como borrador; al guardar, el usuario reingresa su clave y se re-vincula.
            ident = null; saveIdent();
            lastSeen = geomStr(); lastPushed = '';
            if (res.plan_name) lastCreds = { correo: (lastCreds && lastCreds.correo) || '', clave: '' };
            setStatus('Abierto desde tu correo — guarda con tu clave para sincronizar', 'warn');
            toast('Abrimos "' + (res.plan_name || 'tu proyecto') + '". Guarda con tu clave para seguir sincronizando.');
          }
        } else if (res && res.error === 'no_autorizado') {
          toast('Ese proyecto no coincide con tu clave.');
        } else { toast('No se pudo abrir el proyecto.'); }
      })
      .catch(function () { toast('Sin conexión.'); });
  }

  /* ---------------- nudge de guardado (captación de lead) ---------------- */
  function elementCount() {
    try { var g = ed.getGeom();
      return (g.walls||[]).length + (g.windows||[]).length + (g.doors||[]).length +
             (g.sliders||[]).length + (g.furniture||[]).length + (g.labels||[]).length;
    } catch (e) { return 0; }
  }
  var nudgeShown = false, editStart = Date.now();
  function ensureNudge() {
    if ($('ck_nudge')) return;
    var d = document.createElement('div');
    d.id = 'ck_nudge';
    d.setAttribute('style','position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:60;max-width:92vw;background:#16181d;color:#f5f1ea;border-radius:12px;padding:12px 16px;box-shadow:0 10px 34px rgba(0,0,0,.32);display:flex;gap:14px;align-items:center;font-family:var(--fl,sans-serif);font-size:14px');
    d.innerHTML = '<span>Tu plano vive solo en este navegador. Guárdalo y te lo enviamos por correo.</span>' +
      '<button id="ck_nudge_go" style="flex:none;background:#c75b39;color:#fff;border:none;border-radius:8px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer">Guardar y recibirlo</button>' +
      '<button id="ck_nudge_x" aria-label="Cerrar" style="flex:none;background:none;border:none;color:#cdbfb0;font-size:18px;cursor:pointer;padding:0 2px">×</button>';
    document.body.appendChild(d);
    $('ck_nudge_go').addEventListener('click', function () { d.remove(); if ($('ckSaveBtn')) $('ckSaveBtn').click(); });
    $('ck_nudge_x').addEventListener('click', function () { d.remove(); });
  }
  function maybeNudge() {
    if (nudgeShown || ident) return;                       // ya reclamado o ya mostrado
    var enoughEls = elementCount() >= 8;                   // dibujó algo real (>4 muros base)
    var enoughTime = (Date.now() - editStart) > 180000;    // 3 min
    if (enoughEls || enoughTime) { nudgeShown = true; ensureNudge(); }
  }

  /* ---------------- pantalla de éxito (remate comercial) ---------------- */
  function showSuccess(correo, clave, emailed) {
    var ov = $('ck_success');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'ck_success';
      ov.setAttribute('style','position:fixed;inset:0;z-index:80;background:rgba(22,24,29,.62);display:flex;align-items:center;justify-content:center;padding:20px;font-family:var(--fl,sans-serif)');
      document.body.appendChild(ov);
    }
    ov.innerHTML =
      '<div style="background:#fbfaf8;border-radius:16px;max-width:440px;width:100%;padding:26px 24px;box-shadow:0 20px 60px rgba(0,0,0,.3)">' +
        '<div style="font-size:26px">✓</div>' +
        '<h3 style="margin:6px 0 4px;font-size:20px;color:#16181d">¡Tu croquis quedó guardado!</h3>' +
        '<p style="margin:0 0 14px;color:#6b6256;font-size:14px;line-height:1.5">' +
          (emailed ? ('Te enviamos tu clave y el enlace para volver a <b>' + esc(correo) + '</b>. Si no llega en unos minutos, revisa la carpeta de <b>spam</b>.') :
                     ('Guárdate esta clave para volver: se guardó en este navegador.')) +
        '</p>' +
        '<div style="background:#f0ece4;border:1px dashed #c9c4ba;border-radius:10px;padding:10px 14px;margin-bottom:16px">' +
          '<span style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9a8f81">Tu clave</span>' +
          '<div style="font-size:18px;font-weight:600;color:#16181d">' + esc(clave) + '</div>' +
        '</div>' +
        '<a href="' + esc(CONFIG.CONTACT_URL) + '" style="display:block;text-align:center;background:#c75b39;color:#fff;text-decoration:none;border-radius:10px;padding:12px;font-weight:600;font-size:15px;margin-bottom:8px">¿Quieres que Aurum convierta tu croquis en un proyecto real? →</a>' +
        '<button id="ck_succ_close" style="width:100%;background:none;border:1px solid #d8d5cd;border-radius:10px;padding:11px;color:#6b6256;font:inherit;cursor:pointer">Seguir dibujando</button>' +
      '</div>';
    $('ck_succ_close').addEventListener('click', function () { ov.remove(); });
  }

  /* ---------------- arranque ---------------- */
  function fresh() { show($('ck_modal_terreno')); }

  function wire() {
    if ($('ckSaveBtn')) $('ckSaveBtn').addEventListener('click', function () {
      var c = ident || lastCreds;
      if (c) { $('ck_g_correo').value = c.correo || ''; $('ck_g_clave').value = c.clave || ''; }
      $('ck_g_plan').value = (ident && ident.planName) || '';
      show($('ck_modal_guardar'));
    });
    if ($('ckOpenBtn')) $('ckOpenBtn').addEventListener('click', function () { show($('ck_modal_abrir')); });
    if ($('ckNewBtn'))  $('ckNewBtn').addEventListener('click', function () {
      if (confirm('¿Empezar un proyecto nuevo? Guarda el actual con tu clave para no perderlo.')) {
        if (ident) lastCreds = { correo: ident.correo, clave: ident.clave };
        ident = null; saveIdent();
        show($('ck_modal_terreno'));
      }
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
    if ($('ck_s_close')) $('ck_s_close').addEventListener('click', function () { hide($('ck_modal_select')); setStatus(ident ? 'Guardado en la nube ✓' : 'Borrador local', ident ? 'ok' : 'warn'); });

    if ($('ck_select_list')) $('ck_select_list').addEventListener('click', function (e) {
      var b = e.target.closest('[data-id]'); if (!b || !pendingCreds) return;
      hide($('ck_modal_select'));
      openProject(b.getAttribute('data-id'), pendingCreds.correo, pendingCreds.clave);
    });

    // el modal de guardar NO se cierra por clic afuera (evita perder lo tecleado en el punto de conversión)
    ['ck_modal_abrir', 'ck_modal_select'].forEach(function (id) {
      var ov = $(id); if (!ov) return;
      ov.addEventListener('click', function (e) { if (e.target === ov) hide(ov); });
    });
  }

  function boot(editor) {
    ed = editor;
    loadIdent();
    if (ident) lastCreds = { correo: ident.correo, clave: ident.clave };
    wire();

    var openId = new URLSearchParams(location.search).get('open');

    if (openId) {
      openProject(openId);                  // desde el enlace del correo (sin clave en la URL)
    } else if (ident) {
      lastSeen = geomStr(); lastPushed = '';
      setStatus('Guardado en la nube ✓', 'ok');
      scheduleSync();                       // sube cambios locales pendientes de la sesión pasada
    } else if (localStorage.getItem(GEOM_KEY)) {
      lastSeen = geomStr();
      setStatus('Borrador local — guarda con tu clave', 'warn');
    } else {
      setStatus('Borrador local', 'warn');
      fresh();
    }

    setInterval(poll, CONFIG.POLL_MS);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') beacon(); });
    window.addEventListener('pagehide', beacon);
  }

  window.CroKiss = { boot: boot, startTerrain: startTerrain };
})();
