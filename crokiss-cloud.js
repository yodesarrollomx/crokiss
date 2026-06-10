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
    SYNC_DEBOUNCE_MS: 8000,   // inactividad antes de subir a la nube
    POLL_MS: 1500,            // cada cuánto revisa si cambió el plano
    MAX_GEOM_BYTES: 45000,    // tope del plano (mismo límite que el backend)
    MAX_CLAVE: 40             // largo máximo de la clave (mismo límite que el backend)
  };

  var ed = null;
  var ident = null;           // {planId, correo, clave, planName}
  var lastSeen = '';          // último geom visto (string)
  var lastPushed = '';        // último geom subido a la nube (string)
  var dirty = false;
  var busy = false;           // POST de sync en vuelo
  var saving = false;         // POST/GET explícito en vuelo (guardar/abrir)
  var pillClick = false;      // el pill acepta clic para reabrir el guardado
  var pendingOpen = null;     // {planId, correo, planName, baseline} — abierto por enlace, sin clave aún
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

  function setStatus(text, kind, clicable) {
    var el = $('ck_status'); if (!el) return;
    el.textContent = text;
    el.className = 'ck-pill' + (kind ? ' ck-pill--' + kind : '');
    pillClick = !!clicable;
    el.style.cursor = clicable ? 'pointer' : '';
    el.title = clicable ? 'Clic para reabrir el guardado' : '';
  }
  function restoreStatus() {   // nunca dejar el pill colgado en "Abriendo…"/"Guardando…"
    if (ident) setStatus(dirty ? 'Cambios sin subir' : 'Guardado en la nube ✓', dirty ? 'warn' : 'ok', dirty);
    else if (pendingOpen) setStatus('Edición local — escribe tu clave', 'warn');
    else setStatus('Borrador local — guarda con tu clave', 'warn');
  }
  function bytesOf(s) { try { return new Blob([s]).size; } catch (e) { return (s || '').length; } }

  /* mensajes accionables para los códigos de error del backend
     (incluye los códigos viejos por compatibilidad durante la transición) */
  var MENSAJES_ERROR = {
    no_existe:         'Este proyecto ya no existe en la nube. Guárdalo de nuevo para crear uno nuevo.',
    clave_incorrecta:  'La clave no coincide. Revísala en el correo donde te la enviamos.',
    muy_grande:        'Tu plano es demasiado grande para la nube (máx. 45 KB). Borra elementos que no uses e intenta de nuevo.',
    clave_larga:       'Tu clave es demasiado larga: usa 40 caracteres o menos.',
    tope_alcanzado:    'Llegaste al máximo de proyectos para ese correo. Abre uno existente o usa otro correo.',
    spam:              'No pudimos procesar el envío. Recarga la página e intenta de nuevo.',
    // códigos del backend anterior
    no_encontrado:     'No encontramos un proyecto con ese correo y clave.',
    limite_por_correo: 'Llegaste al máximo de proyectos para ese correo. Abre uno existente o usa otro correo.',
    plano_muy_grande:  'Tu plano es demasiado grande para la nube. Borra elementos que no uses e intenta de nuevo.',
    clave_invalida:    'Tu clave no es válida: usa de 1 a 40 caracteres.',
    correo_invalido:   'Escribe un correo válido.',
    plano_invalido:    'El plano no se pudo leer. Recarga la página; tu dibujo sigue en este navegador.'
  };
  function errMsg(code, porDefecto) { return MENSAJES_ERROR[code] || porDefecto; }
  function esDeterminista(code) { return !!MENSAJES_ERROR[code]; }   // reintentar no lo arregla

  function loadIdent() { try { ident = JSON.parse(localStorage.getItem(ID_KEY) || 'null'); } catch (e) { ident = null; } }
  function saveIdent() { try { localStorage.setItem(ID_KEY, JSON.stringify(ident)); } catch (e) {} }
  function clearIdent() { ident = null; try { localStorage.removeItem(ID_KEY); } catch (e) {} }
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
    if (!ident) return;
    if (busy) { retry(); return; }            // hay un POST en vuelo: reintentar después, no descartar
    var snapshot = geomStr();
    if (snapshot === lastPushed) { dirty = false; setStatus('Guardado en la nube ✓', 'ok'); return; }
    if (bytesOf(snapshot) > CONFIG.MAX_GEOM_BYTES) {   // determinista: reintentar no lo arregla
      setStatus('Plano muy grande — sin subir', 'warn', true);
      toast(MENSAJES_ERROR.muy_grande);
      return;
    }
    busy = true;
    post({ mode: 'sync', correo: ident.correo, clave: ident.clave, client_id: clientId(), geom: ed.getGeom() })
      .then(function (res) {
        busy = false;
        if (!ident) return;                   // soltaron la identidad ("Nuevo") con el POST en vuelo
        if (res && res.ok) {
          lastPushed = snapshot;
          if (res.plan_id) { ident.planId = res.plan_id; saveIdent(); }
          if (geomStr() !== lastPushed) {     // hubo cambios durante el vuelo: van en el siguiente
            dirty = true; setStatus('Guardando…', 'saving'); retry();
          } else { dirty = false; setStatus('Guardado en la nube ✓', 'ok'); }
        } else if (res && (res.error === 'no_existe' || res.error === 'clave_incorrecta')) {
          // el proyecto ya no está (fila borrada / clave cambiada): detener el
          // retry infinito, soltar la identidad y dejar la app usable
          clearIdent(); dirty = false;
          if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
          setStatus('Borrador local — guarda con tu clave', 'warn', true);
          toast(MENSAJES_ERROR.no_existe);
        } else if (res && esDeterminista(res.error)) {
          setStatus('Sin subir — revisa el aviso', 'warn', true);
          toast(errMsg(res.error, 'No se pudo subir el plano.'));
        } else { setStatus('Sin guardar — reintentando…', 'warn', true); retry(); }
      })
      .catch(function () { busy = false; setStatus('Sin conexión — guardado local', 'warn', true); retry(); });
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
    // cinturón y tirantes: TODO terreno nuevo es un proyecto nuevo — soltar
    // cualquier identidad pendiente para que el sync jamás pise el anterior
    clearIdent(); pendingOpen = null; hideClaveBar(); dirty = false;
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    var g = buildLotGeom(w, d);
    if (ed.loadGeom(g)) {
      lastSeen = geomStr(); lastPushed = '';        // nuevo local, aún no en nube
      hide($('ck_modal_terreno'));
      setStatus('Borrador local — guarda con tu clave', 'warn');
      toast('Terreno de ' + g.lot.w + ' × ' + g.lot.d + ' m. Dibuja tus muros dentro.');
    }
  }

  /* ---------------- guardar a la nube + correo ---------------- */

  /* aviso con la clave en pantalla cuando el correo no pudo enviarse:
     el lead nuevo NO debe quedarse sin su clave sin enterarse */
  function showClaveAviso(clave) {
    var old = $('ck_aviso_clave'); if (old) old.remove();
    var ov = document.createElement('div');
    ov.id = 'ck_aviso_clave'; ov.className = 'ck-overlay';
    ov.innerHTML =
      '<div class="ck-modal" role="alertdialog" aria-label="Guarda tu clave">' +
        '<h3>Guardado ✓ — pero el correo no pudo enviarse</h3>' +
        '<p>Apunta tu clave para volver a tu proyecto:</p>' +
        '<p style="display:flex;gap:8px;align-items:center;">' +
          '<strong id="ck_aviso_txt" style="font-size:18px;letter-spacing:1px;">' +
            String(clave).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</strong>' +
          '<button type="button" class="btn" id="ck_aviso_copiar">Copiar clave</button>' +
        '</p>' +
        '<p class="ck-mini">Entra de nuevo con tu correo y esta clave desde «Abrir».</p>' +
        '<button type="button" class="btn primary" id="ck_aviso_ok">Entendido</button>' +
      '</div>';
    document.body.appendChild(ov);
    $('ck_aviso_ok').addEventListener('click', function () { ov.remove(); });
    $('ck_aviso_copiar').addEventListener('click', function () {
      try { navigator.clipboard.writeText(clave); toast('Clave copiada'); }
      catch (e) { toast('Selecciona y copia la clave a mano'); }
    });
  }

  function submitSave() {
    if (saving) return;                       // evita el doble POST por doble clic
    var nombre = ($('ck_g_nombre').value || '').trim();
    var correo = ($('ck_g_correo').value || '').trim().toLowerCase();
    var clave  = ($('ck_g_clave').value  || '').trim();
    var planNm = ($('ck_g_plan').value   || '').trim() || 'Mi proyecto';
    var mkt    = $('ck_g_mkt') ? $('ck_g_mkt').checked : false;
    var honey  = $('ck_g_web') ? $('ck_g_web').value : '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) { toast('Escribe un correo válido'); return; }
    if (!clave) { toast('Elige una clave para volver a tu proyecto'); return; }
    if (clave.length > CONFIG.MAX_CLAVE) { toast(MENSAJES_ERROR.clave_larga); return; }
    if (bytesOf(geomStr()) > CONFIG.MAX_GEOM_BYTES) { toast(MENSAJES_ERROR.muy_grande); return; }

    saving = true;
    var btn = $('ck_g_go'); if (btn) btn.disabled = true;
    function done() { saving = false; if (btn) btn.disabled = false; }
    setStatus('Guardando…', 'saving');
    post({ mode: 'save', nombre: nombre, correo: correo, clave: clave, plan_name: planNm,
           marketing: mkt, website: honey, client_id: clientId(), geom: ed.getGeom() })
      .then(function (res) {
        done();
        if (res && res.ok) {
          ident = { planId: res.plan_id, correo: correo, clave: clave, planName: planNm };
          pendingOpen = null;
          saveIdent();
          lastPushed = geomStr(); lastSeen = lastPushed; dirty = false;
          hide($('ck_modal_guardar'));
          setStatus('Guardado en la nube ✓', 'ok');
          if (res.emailed) toast('Guardado. Te enviamos tu clave a ' + correo);
          else if (res.isNew) showClaveAviso(clave);   // correo caído: la clave en pantalla
          else toast('Guardado en la nube ✓');
        } else {
          toast(errMsg(res && res.error, 'No se pudo guardar. Intenta de nuevo.'));
          restoreStatus();
        }
      })
      .catch(function () {
        done();
        toast('Sin conexión. Tu plano sigue guardado en este navegador.');
        setStatus('Sin conexión — guardado local', 'warn', true);
      });
  }

  /* ---------------- abrir con clave ---------------- */
  function submitOpen() {
    if (saving) return;
    var correo = ($('ck_a_correo').value || '').trim().toLowerCase();
    var clave  = ($('ck_a_clave').value  || '').trim();
    if (!correo || !clave) { toast('Escribe tu correo y tu clave'); return; }
    saving = true;
    var btn = $('ck_a_go'); if (btn) btn.disabled = true;
    function done() { saving = false; if (btn) btn.disabled = false; }
    setStatus('Abriendo…', 'saving');
    get({ action: 'open', correo: correo, clave: clave })
      .then(function (res) {
        done();
        if (res && res.ok && res.geom) {
          ed.loadGeom(res.geom);
          ident = { planId: res.plan_id, correo: correo, clave: clave, planName: res.plan_name || 'Mi proyecto' };
          pendingOpen = null;
          saveIdent();
          lastPushed = geomStr(); lastSeen = lastPushed; dirty = false;
          hide($('ck_modal_abrir')); hide($('ck_modal_terreno')); hideClaveBar();
          setStatus('Guardado en la nube ✓', 'ok');
          toast('Proyecto abierto: ' + ident.planName);
        } else {
          toast(errMsg(res && res.error, 'No encontramos un proyecto con ese correo y clave.'));
          restoreStatus();
        }
      })
      .catch(function () { done(); toast('Sin conexión. Inténtalo más tarde.'); restoreStatus(); });
  }

  /* ---- abrir por enlace ?open=ID: la respuesta YA NO trae la clave ----
     El plano se carga y se puede editar en local; para reactivar el guardado
     en nube, una barra discreta pide la clave (que viene en el mismo correo
     donde llegó el enlace) y se valida con el flujo normal de abrir. */
  function showClaveBar() {
    if ($('ck_clavebar')) return;
    var bar = document.createElement('div');
    bar.id = 'ck_clavebar'; bar.className = 'ck-clavebar';
    bar.innerHTML =
      '<span>Estás viendo tu plano. Escribe tu clave para guardar cambios en la nube:</span>' +
      '<input type="password" id="ck_cb_clave" placeholder="Tu clave" maxlength="40" autocomplete="current-password">' +
      '<button type="button" class="btn primary" id="ck_cb_go">Activar guardado</button>' +
      '<button type="button" class="btn" id="ck_cb_x" aria-label="Cerrar">✕</button>';
    document.body.appendChild(bar);
    function activar() {
      if (!pendingOpen) return;
      var clave = ($('ck_cb_clave').value || '').trim();
      if (!clave) { toast('Escribe la clave que te llegó por correo'); return; }
      setStatus('Verificando…', 'saving');
      // valida credenciales SIN pisar lo editado: el geom local manda
      get({ action: 'open', correo: pendingOpen.correo, clave: clave })
        .then(function (res) {
          if (res && res.ok) {
            ident = { planId: res.plan_id || pendingOpen.planId, correo: pendingOpen.correo,
                      clave: clave, planName: res.plan_name || pendingOpen.planName };
            pendingOpen = null;
            saveIdent();
            lastSeen = geomStr(); lastPushed = '';   // sube lo editado en local
            hideClaveBar();
            toast('Guardado en la nube activado ✓');
            scheduleSync();
          } else {
            toast(errMsg(res && res.error, 'La clave no coincide. Revísala en tu correo.'));
            restoreStatus();
          }
        })
        .catch(function () { toast('Sin conexión. Inténtalo más tarde.'); restoreStatus(); });
    }
    $('ck_cb_go').addEventListener('click', activar);
    $('ck_cb_clave').addEventListener('keydown', function (e) { if (e.key === 'Enter') activar(); });
    $('ck_cb_x').addEventListener('click', hideClaveBar);
  }
  function hideClaveBar() { var b = $('ck_clavebar'); if (b) b.remove(); }

  function openById(planId) {
    setStatus('Abriendo…', 'saving');
    get({ action: 'plan', id: planId })
      .then(function (res) {
        if (res && res.ok && res.geom) {
          ed.loadGeom(res.geom);
          lastSeen = geomStr(); dirty = false;
          if (res.clave) {                    // backend anterior: aún manda la clave
            ident = { planId: res.plan_id || planId, correo: res.correo, clave: res.clave, planName: res.plan_name || 'Mi proyecto' };
            saveIdent();
            lastPushed = lastSeen;
            setStatus('Guardado en la nube ✓', 'ok');
          } else {                            // protocolo nuevo: editar local + pedir clave
            // clearIdent (no solo ident=null): si quedara la identidad ANTERIOR
            // en localStorage, la próxima sesión subiría este plano sobre aquel proyecto
            clearIdent(); lastPushed = '';
            pendingOpen = { planId: res.plan_id || planId, correo: res.correo, planName: res.plan_name || 'Mi proyecto' };
            showClaveBar();
            setStatus('Edición local — escribe tu clave', 'warn');
          }
          toast('Proyecto abierto: ' + (res.plan_name || 'Mi proyecto'));
        } else {
          // enlace roto: soltar también la identidad — si el usuario siembra un
          // terreno nuevo desde aquí, no debe pisar el proyecto guardado
          clearIdent();
          toast(errMsg(res && res.error, 'Ese enlace no encontró el proyecto.'));
          restoreStatus(); fresh();
        }
      })
      .catch(function () { toast('Sin conexión.'); restoreStatus(); });
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
      // CRÍTICO: soltar la identidad ANTES de sembrar el terreno nuevo; si no,
      // el sync sube el terreno vacío ENCIMA del proyecto guardado (~2 s después)
      var msg = ident
        ? 'Tu proyecto «' + (ident.planName || 'Mi proyecto') + '» queda a salvo en la nube; podrás volver a abrirlo con tu correo y clave.\n\n¿Empezar un proyecto nuevo?'
        : 'Tu borrador actual no está guardado en la nube y se perderá al crear el terreno nuevo.\n\n¿Empezar de todas formas?';
      if (!confirm(msg)) return;
      if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
      clearIdent(); pendingOpen = null; hideClaveBar();
      dirty = false; lastPushed = '';
      setStatus('Borrador local', 'warn');
      show($('ck_modal_terreno'));
    });

    // el pill de estado reabre el guardado cuando hay algo que atender
    if ($('ck_status')) $('ck_status').addEventListener('click', function () {
      if (!pillClick) return;
      if (ident) { $('ck_g_correo').value = ident.correo || ''; $('ck_g_clave').value = ident.clave || ''; $('ck_g_plan').value = ident.planName || ''; }
      show($('ck_modal_guardar'));
    });

    // Esc cierra los modales (el de terreno solo si ya hay un plano debajo)
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      hide($('ck_modal_guardar')); hide($('ck_modal_abrir'));
      if (localStorage.getItem(GEOM_KEY)) hide($('ck_modal_terreno'));
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
      // lastPushed = lastSeen: lo local se asume ya subido; el poll detectará
      // cualquier cambio real. (Antes, lastPushed='' subía una "versión
      // fantasma" idéntica en CADA recarga de página.)
      lastSeen = geomStr(); lastPushed = lastSeen;
      setStatus('Guardado en la nube ✓', 'ok');
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
