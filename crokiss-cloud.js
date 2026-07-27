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
    /* CTA de la pantalla de éxito y del pie del correo.
       Es el WhatsApp que ya publica yodesarrollo.mx (662 318 4512). Si Aurum
       usa otro número, cambia SOLO los dígitos de aquí abajo: es la única
       línea que hay que tocar, y el pie del correo lo lee de Code.gs.
       Formato: 521 + los 10 dígitos, sin espacios ni signos. */
    WHATSAPP: 'https://wa.me/5216623184512?text=' +
      encodeURIComponent('Hola Aurum, hice mi croquis en CroKiss y quiero que lo vean.'),
    CONTACT_URL: 'mailto:direccion@aurumarquitectos.com?subject=Quiero%20que%20Aurum%20revise%20mi%20croquis%20CroKiss'
  };

  var ed = null;
  var ident = null;            // {planId, correo, clave, planName}
  var lastCreds = null;        // {correo, clave} para precargar el modal de guardar
  var pendingCreds = null;     // credenciales en curso durante "abrir"
  var reclamarId = null;       // plan abierto desde ?open SIN clave: al guardar,
                               // esta pista deja reanudar ESE proyecto (el backend
                               // la ignora si las credenciales no son sus dueñas)
  var lastSeen = '';
  var lastPushed = '';
  var dirty = false;
  var busy = false;
  var syncTimer = null;
  var retryDelay = 5000;   // backoff exponencial de reintentos

  var ID_KEY    = 'crokiss_identity_v1';
  var CLAVE_KEY = 'crokiss_clave_v1';       // sessionStorage: muere al cerrar el navegador
  var GEOM_KEY  = 'marbel_editor_geom_v1';  // misma caché del motor
  var IDENT_TTL_MS = 30 * 24 * 3600 * 1000; // la identidad caduca a los 30 días sin uso

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
    no_disponible:       'Este enlace ya venció. Pídele al dueño que lo reabra, o dibuja el tuyo gratis.',
    no_encontrado:       'No encontramos ese proyecto.',
    error_interno:       'Algo falló de nuestro lado. Tu plano sigue a salvo en este navegador.'
  };
  function msgError(code) {
    return ERRORES[code] || 'No se pudo guardar. Tu plano sigue guardado en este navegador.';
  }
  function tooBig(s) {
    var n = (s == null ? geomStr() : s).length;
    return n > CONFIG.MAX_GEOM_BYTES;
  }

  /* ================= embudo (P4) =================
     La analítica de CroKiss es su propia hoja: sin Google Analytics, sin
     cookies de terceros. track() encola en localStorage y sube por lotes.
     Regla de oro: los eventos son BEST-EFFORT. Ante cualquier conflicto entre
     medir y guardar el plano, gana el plano — por eso nunca bloquea la UI, no
     reintenta con backoff y si falla se queda en cola para el próximo lote. */
  var EV_KEY = 'ck_events_v1';
  var EV_MAX = 100;                      // tope de cola: medir no debe llenar el disco
  var evTimer = null;
  var evVistos = {};                     // eventos de "una sola vez por sesión"

  function evLee() { try { return JSON.parse(localStorage.getItem(EV_KEY) || '[]'); } catch (e) { return []; } }
  function evGuarda(a) { try { localStorage.setItem(EV_KEY, JSON.stringify(a.slice(-EV_MAX))); } catch (e) {} }

  function track(evento, extra, unaVez) {
    try {
      if (unaVez) { if (evVistos[evento]) return; evVistos[evento] = true; }
      var cola = evLee();
      cola.push({ evento: String(evento || '').slice(0, 40),
                  extra: extra == null ? '' : String(extra).slice(0, 120),
                  ts: new Date().toISOString() });
      evGuarda(cola);
      if (!evTimer) evTimer = setTimeout(evEnvia, 30000);      // se agrupa 30 s
    } catch (e) {}
  }

  function evEnvia() {
    evTimer = null;
    var cola = evLee();
    if (!cola.length) return;
    var lote = cola.slice(0, 20);
    post({ mode: 'event', client_id: clientId(), eventos: lote })
      .then(function (res) {
        if (res && res.ok) {
          evGuarda(evLee().slice(lote.length));                // solo se borra lo confirmado
          if (evLee().length && !evTimer) evTimer = setTimeout(evEnvia, 30000);
        }
        // si no salió, se queda en cola: se reintenta con el siguiente evento
      })
      .catch(function () {});
  }

  // Al cerrar la pestaña se manda lo pendiente con sendBeacon (no bloquea).
  function evBeacon() {
    try {
      var cola = evLee();
      if (!cola.length || !navigator.sendBeacon) return;
      var blob = new Blob([JSON.stringify({ mode: 'event', client_id: clientId(), eventos: cola.slice(0, 20) })],
                          { type: 'text/plain;charset=utf-8' });
      if (navigator.sendBeacon(CONFIG.ENDPOINT, blob)) evGuarda(evLee().slice(20));
    } catch (e) {}
  }

  /* Clave sugerida: un campo vacío obliga a inventar algo y ahí se pierde gente.
     Se propone una amable y editable. Cumple el formato de P2 (6-32 caracteres,
     solo letras, números, espacio, punto, guion y guion bajo). */
  var PALABRAS = ['mi-casa', 'mi-plano', 'mi-terreno', 'mi-proyecto', 'mi-croquis', 'mi-hogar'];
  function claveSugerida() {
    var w = PALABRAS[Math.floor(Math.random() * PALABRAS.length)];
    return w + '-' + (100 + Math.floor(Math.random() * 900));
  }
  function sugiereClave() {
    var el = $('ck_g_clave');
    if (el && !el.value) el.value = claveSugerida();
  }

  function copiaAMano(txt, listo) {
    try {
      var ta = document.createElement('textarea');
      ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      listo();
    } catch (e) { toast('Copia este enlace: ' + txt); }
  }

  /* El PNG que viaja en el guardado para que el correo ENTREGUE el plano, no
     solo la clave. Best-effort con tres salidas a null: si el navegador no
     puede (canvas viejo), si pesa de más (>1.5 MB) o si tarda >2.5 s. El
     guardado JAMÁS espera al PNG más de eso: primero el lead, luego el adorno. */
  function capturaPNG(cb) {
    var listo = false;
    function fin(v) { if (!listo) { listo = true; clearTimeout(t); cb(v); } }
    var t = setTimeout(function () { fin(null); }, 2500);
    try {
      if (!ed || !ed.exportPNG) return fin(null);
      ed.exportPNG(function (blob) {
        if (!blob || blob.size > 1500000) return fin(null);
        var r = new FileReader();
        r.onload = function () { fin(String(r.result || '') || null); };
        r.onerror = function () { fin(null); };
        r.readAsDataURL(blob);
      });
    } catch (e) { fin(null); }
  }

  /* WhatsApp si ya hay número; si no, el correo de siempre. Nunca un enlace roto. */
  function contactURL() {
    return /X{5,}/.test(CONFIG.WHATSAPP) ? CONFIG.CONTACT_URL : CONFIG.WHATSAPP;
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
  /* ---------------- identidad e higiene de sesión ----------------
     La clave YA NO se guarda en localStorage: vive en sessionStorage, así que
     desaparece al cerrar el navegador. En una computadora compartida, el
     siguiente en sentarse ya no hereda la sesión de nadie.
     En localStorage queda solo lo no sensible (planId, correo, nombre del
     proyecto) con un sello de tiempo: a los 30 días sin uso se descarta.
     Consecuencia buscada: al volver en otra sesión hay que reescribir la clave
     para reanudar el sync. El plano local NUNCA se pierde por esto. */
  function loadIdent() {
    ident = null;
    try {
      var raw = JSON.parse(localStorage.getItem(ID_KEY) || 'null');
      if (!raw) return;
      if (raw.ts && (Date.now() - raw.ts) > IDENT_TTL_MS) { localStorage.removeItem(ID_KEY); return; }
      var clave = '';
      try { clave = sessionStorage.getItem(CLAVE_KEY) || ''; } catch (e) {}
      ident = { planId: raw.planId, correo: raw.correo, planName: raw.planName, clave: clave, ts: raw.ts };
    } catch (e) { ident = null; }
  }
  function saveIdent() {
    try {
      if (!ident) { localStorage.removeItem(ID_KEY); sessionStorage.removeItem(CLAVE_KEY); actualizaSesionUI(); return; }
      ident.ts = Date.now();                       // ventana móvil: 30 días desde la última actividad
      localStorage.setItem(ID_KEY, JSON.stringify({
        planId: ident.planId, correo: ident.correo, planName: ident.planName, ts: ident.ts
      }));
      if (ident.clave) sessionStorage.setItem(CLAVE_KEY, ident.clave);
      else sessionStorage.removeItem(CLAVE_KEY);
    } catch (e) {}
    actualizaSesionUI();
  }
  // Sesión utilizable = hay proyecto reclamado Y tenemos su clave en esta sesión.
  function sesionViva() { return !!(ident && ident.clave); }

  function actualizaSesionUI() {
    var b = $('ckLogoutBtn');
    if (b) b.style.display = sesionViva() ? '' : 'none';
  }
  function cerrarSesion() {
    ident = null; lastCreds = null; pendingCreds = null; reclamarId = null;
    lastPushed = ''; dirty = false;
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
    try { localStorage.removeItem(ID_KEY); sessionStorage.removeItem(CLAVE_KEY); } catch (e) {}
    actualizaSesionUI();
    setStatus('Borrador local', 'warn');
    toast('Cerraste sesión. Tu plano sigue en este navegador.');
  }
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
  /* Ruta con credenciales: se intenta por POST (la clave NO va en la URL, donde
     quedaría en el historial del navegador y en los logs). Si el backend
     desplegado todavía es el anterior, no conoce mode:'abrir'/'plan' y responde
     'plano_invalido' porque busca un geom que no mandamos: en ese caso se cae a
     la ruta GET de siempre. Así el front puede publicarse ANTES que el Code.gs
     sin romper "Abrir con clave" a nadie. */
  function postCreds(payload, paramsGet) {
    return post(payload)
      .then(function (res) {
        if (res && res.error === 'plano_invalido') return get(paramsGet);   // backend viejo
        return res;
      })
      .catch(function () { return get(paramsGet); });
  }

  function scheduleSync() {
    if (!sesionViva()) return;           // sin proyecto reclamado (o sin clave en esta sesión): solo local
    dirty = true;
    setStatus('Guardando…', 'saving');
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(doSync, CONFIG.SYNC_DEBOUNCE_MS);
  }
  function doSync() {
    if (!sesionViva()) return;
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
    if (s && s !== lastSeen) {
      lastSeen = s;
      // 4 muros = el terreno recién sembrado; a partir del 5º ya dibujó algo suyo
      if (elementCount() > 4) track('primer_elemento', elementCount(), true);
      scheduleSync();
    }
    maybeNudge();
  }
  function beacon() {
    if (!sesionViva() || !dirty) return;
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
  /* Mini-vista del lote mientras se teclea: ver el rectángulo cambiar de forma
     convierte dos números abstractos en "mi terreno" antes de tocar nada. */
  function dibujaLote() {
    var cont = $('ck_lote_prev'); if (!cont) return;
    var w = num($('ck_ancho') && $('ck_ancho').value), d = num($('ck_fondo') && $('ck_fondo').value);
    if (!(w > 0) || !(d > 0)) { cont.innerHTML = ''; return; }
    var CAJA = 132, esc = Math.min(CAJA / w, CAJA / d);
    var pw = Math.max(8, w * esc), ph = Math.max(8, d * esc);
    var VW = CAJA + 46, VH = CAJA + 34, x = (VW - pw) / 2, y = (VH - ph) / 2 + 4;
    cont.innerHTML =
      '<svg viewBox="0 0 ' + VW + ' ' + VH + '" style="width:190px;height:auto" aria-hidden="true">' +
        '<rect x="' + x + '" y="' + y + '" width="' + pw + '" height="' + ph + '" ' +
          'fill="#fbfaf8" stroke="#16181d" stroke-width="2.5"/>' +
        '<line x1="' + x + '" y1="' + (y - 9) + '" x2="' + (x + pw) + '" y2="' + (y - 9) + '" ' +
          'stroke="#c75b39" stroke-width="1"/>' +
        '<text x="' + (x + pw / 2) + '" y="' + (y - 13) + '" text-anchor="middle" ' +
          'font-family="Saira Semi Condensed,sans-serif" font-size="10" fill="#c75b39">' + w + ' m</text>' +
        '<text x="' + (x - 8) + '" y="' + (y + ph / 2) + '" text-anchor="middle" ' +
          'font-family="Saira Semi Condensed,sans-serif" font-size="10" fill="#c75b39" ' +
          'transform="rotate(-90 ' + (x - 8) + ' ' + (y + ph / 2) + ')">' + d + ' m</text>' +
        '<text x="' + (VW / 2) + '" y="' + (VH - 2) + '" text-anchor="middle" ' +
          'font-family="Saira Semi Condensed,sans-serif" font-size="10.5" fill="#6b6256">' +
          (Math.round(w * d * 100) / 100) + ' m²</text>' +
      '</svg>';
  }

  function startTerrain(w, d) {
    w = num(w); d = num(d);
    if (!(w > 0) || !(d > 0)) { toast('Escribe el ancho y el fondo en metros'); return; }
    var g = buildLotGeom(w, d);
    if (ed.loadGeom(g)) {
      reclamarId = null;                 // terreno nuevo = proyecto nuevo de verdad
      lastSeen = geomStr(); lastPushed = '';
      hide($('ck_modal_terreno'));
      track('terreno_creado', g.lot.w + 'x' + g.lot.d);
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
    var tel    = $('ck_g_tel') ? ($('ck_g_tel').value || '').replace(/[^0-9+() -]/g, '').slice(0, 20) : '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) { toast('Escribe un correo válido'); return; }
    if (!clave) { toast('Elige una clave para volver a tu proyecto'); return; }
    if (tooBig()) { toast(MSG_GRANDE); setStatus('Sin guardar — plano muy grande', 'warn'); return; }

    setStatus('Guardando…', 'saving');
    capturaPNG(function (png) {
    post({ mode: 'save', plan_id: (ident && ident.planId) || '',
           reclamar_id: (!ident || !ident.planId) ? (reclamarId || '') : '',
           nombre: nombre, correo: correo, clave: clave,
           plan_name: planNm, marketing: mkt, website: honey, telefono: tel,
           png: png || undefined, client_id: clientId(), geom: ed.getGeom() })
      .then(function (res) {
        if (res && res.ok) {
          // El backend renombra en vez de sobrescribir: si ya tenías un
          // proyecto con ese nombre, este se guardó como «X (2)» — se avisa.
          var nombreFinal = res.plan_name || planNm;
          if (nombreFinal !== planNm)
            toast('Ya tenías un proyecto llamado \u00ab' + planNm + '\u00bb \u2014 este se guard\u00f3 como \u00ab' + nombreFinal + '\u00bb');
          reclamarId = null;
          ident = { planId: res.plan_id, correo: correo, clave: clave, planName: nombreFinal };
          lastCreds = { correo: correo, clave: clave };
          saveIdent();
          lastPushed = geomStr(); lastSeen = lastPushed; dirty = false;
          hide($('ck_modal_guardar'));
          setStatus('Guardado en la nube ✓', 'ok');
          if ($('ck_nudge')) { $('ck_nudge').remove(); document.body.classList.remove('con-nudge'); }
          track('guardado_ok', res.isNew ? 'nuevo' : 'actualizado');
          showSuccess(correo, clave, !!res.emailed);
        } else {
          track('guardado_error', (res && res.error) || 'desconocido');
          toast(msgError(res && res.error)); setStatus('Sin guardar', 'warn');
        }
      })
      .catch(function () {
        track('guardado_error', 'sin_conexion');
        toast('Sin conexión. Tu plano sigue guardado en este navegador.');
        setStatus('Sin conexión — guardado local', 'warn');
      });
    });
  }

  /* Borrar mis datos (ARCO). Es definitivo y se dice con todas sus letras. */
  function submitBorrar() {
    var correo = ($('ck_b_correo').value || '').trim().toLowerCase();
    var clave  = ($('ck_b_clave').value  || '').trim();
    if (!correo || !clave) { toast('Escribe tu correo y tu clave'); return; }
    var btn = $('ck_b_go'); if (btn) btn.disabled = true;
    post({ mode: 'borrar', correo: correo, clave: clave })
      .then(function (res) {
        if (btn) btn.disabled = false;
        if (res && res.ok) {
          hide($('ck_modal_borrar')); hide($('ck_modal_guardar'));
          cerrarSesion();
          toast('Listo: borramos ' + res.planos + ' proyecto(s) de nuestra hoja.');
        } else {
          toast(msgError(res && res.error));
        }
      })
      .catch(function () { if (btn) btn.disabled = false; toast('Sin conexión. Inténtalo más tarde.'); });
  }

  /* ---------------- abrir con clave (lista + selector) ---------------- */
  function submitOpen() {
    var correo = ($('ck_a_correo').value || '').trim().toLowerCase();
    var clave  = ($('ck_a_clave').value  || '').trim();
    if (!correo || !clave) { toast('Escribe tu correo y tu clave'); return; }
    setStatus('Buscando…', 'saving');
    postCreds({ mode: 'abrir', correo: correo, clave: clave },
              { action: 'list', correo: correo, clave: clave })
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
    // Con credenciales va por POST (nada secreto en la URL); el enlace del
    // correo no trae clave, así que ahí un GET normal no expone nada.
    var pedir = (correo && clave)
      ? postCreds({ mode: 'plan', id: planId, correo: correo, clave: clave },
                  { action: 'plan', id: planId, correo: correo, clave: clave })
      : get({ action: 'plan', id: planId });
    pedir
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
            // Retorno en UN paso: si ya conocíamos su correo en este navegador,
            // se conserva para precargarlo y que solo tenga que teclear la clave.
            var correoPrevio = (ident && ident.correo) || (lastCreds && lastCreds.correo) || '';
            ident = null; saveIdent();
            reclamarId = res.plan_id || planId;
            lastSeen = geomStr(); lastPushed = '';
            lastCreds = correoPrevio ? { correo: correoPrevio, clave: '' } : null;
            setStatus('Escribe tu clave para seguir guardando en la nube', 'warn');
            toast('Abrimos "' + (res.plan_name || 'tu proyecto') + '". Escribe tu clave para seguir guardando en la nube.');
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
    // La maquetación vive en el CSS (clase .ck-nudge), no en un style en línea:
    // con `left:50%` + `translateX(-50%)` y un ancho que no cabía, en un
    // teléfono el aviso se salía de la pantalla y su botón —el CTA de captación
    // de leads— quedaba literalmente fuera del alcance del dedo.
    d.className = 'ck-nudge';
    d.innerHTML = '<span class="ck-nudge-txt">Tu plano vive solo en este navegador. Guárdalo y te lo enviamos por correo.</span>' +
      '<button id="ck_nudge_go" class="ck-nudge-go">Guardar y recibirlo</button>' +
      '<button id="ck_nudge_x" class="ck-nudge-x" aria-label="Cerrar aviso">×</button>';
    document.body.appendChild(d);
    // el toast se sube por encima del aviso para que no se pisen en un teléfono
    function quitar() {
      d.remove();
      document.body.classList.remove('con-nudge');
      document.body.style.removeProperty('--nudgeH');
    }
    document.body.classList.add('con-nudge');
    document.body.style.setProperty('--nudgeH', Math.round(d.getBoundingClientRect().height) + 'px');
    $('ck_nudge_go').addEventListener('click', function () { quitar(); if ($('ckSaveBtn')) $('ckSaveBtn').click(); });
    $('ck_nudge_x').addEventListener('click', quitar);
  }
  function maybeNudge() {
    if (nudgeShown || ident) return;                       // ya reclamado o ya mostrado
    // No pedirle que guarde algo que todavía no hace suyo:
    //  · con un modal abierto el aviso queda debajo y solo estorba;
    //  · sin terreno elegido, el lienzo trae una geometría de MUESTRA heredada
    //    (22 elementos) que disparaba el aviso al segundo de entrar.
    if (document.querySelector('.ck-overlay:not([hidden])')) return;
    var g = null;
    try { g = ed.getGeom(); } catch (e) {}
    if (!g || !g.lot) return;                              // aún no hay terreno propio
    var propios = elementCount() - 4;                      // los 4 muros del terreno no cuentan
    var enoughEls = propios >= 4;                          // ya dibujó algo suyo
    var enoughTime = (Date.now() - editStart) > 180000 && propios >= 1;
    if (enoughEls || enoughTime) { nudgeShown = true; ensureNudge(); track('nudge_visto', enoughEls ? 'elementos' : 'tiempo'); }
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
        '<div style="background:#f0ece4;border:1px dashed #c9c4ba;border-radius:10px;padding:10px 14px;margin-bottom:16px;display:flex;align-items:center;gap:10px">' +
          '<div style="flex:1;min-width:0">' +
            '<span style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9a8f81">Tu clave</span>' +
            '<div style="font-size:18px;font-weight:600;color:#16181d;word-break:break-all">' + esc(clave) + '</div>' +
          '</div>' +
          '<button id="ck_succ_copy" style="flex:none;background:#fff;border:1px solid #c75b39;border-radius:8px;padding:9px 12px;color:#c75b39;font:inherit;font-size:13px;font-weight:600;cursor:pointer;min-height:44px">Copiar</button>' +
        '</div>' +
        '<a href="' + esc(contactURL()) + '" id="ck_cta" target="_blank" rel="noopener" style="display:block;text-align:center;background:#c75b39;color:#fff;text-decoration:none;border-radius:10px;padding:12px;font-weight:600;font-size:15px;margin-bottom:8px">¿Quieres que Aurum convierta tu croquis en un proyecto real? →</a>' +
        (ident && ident.planId
          ? '<button id="ck_succ_link" style="width:100%;background:none;border:1px solid #c75b39;border-radius:10px;padding:11px;color:#c75b39;font:inherit;font-weight:600;cursor:pointer;margin-bottom:8px">🔗 Compartir enlace de mi croquis</button>'
          : '') +
        '<button id="ck_succ_close" style="width:100%;background:none;border:1px solid #d8d5cd;border-radius:10px;padding:11px;color:#6b6256;font:inherit;cursor:pointer">Seguir dibujando</button>' +
      '</div>';
    $('ck_succ_close').addEventListener('click', function () { ov.remove(); });
    // La clave a un toque: quien no la copia, la pierde al cerrar el navegador
    // (la sesión muere a propósito) y su único regreso es un correo que puede
    // caer en spam. Este botón es la red de seguridad barata.
    if ($('ck_succ_copy')) $('ck_succ_copy').addEventListener('click', function () {
      var listo = function () { toast('Clave copiada — pégala donde no se te pierda'); };
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(clave).then(listo, function () { copiaAMano(clave, listo); });
      else copiaAMano(clave, listo);
    });
    if ($('ck_cta')) $('ck_cta').addEventListener('click', function () { track('cta_contacto_click'); });
    if ($('ck_succ_link')) $('ck_succ_link').addEventListener('click', function () {
      var url = location.origin + location.pathname + '?plan=' + encodeURIComponent(ident.planId);
      var listo = function () { toast('Enlace copiado — pégalo donde quieras'); track('compartir_enlace'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(listo).catch(function () { copiaAMano(url, listo); });
      } else copiaAMano(url, listo);
    });
  }

  /* ---------------- arranque ---------------- */
  function fresh() { show($('ck_modal_terreno')); }

  function wire() {
    if ($('ckSaveBtn')) $('ckSaveBtn').addEventListener('click', function () {
      var c = ident || lastCreds;
      // Se precarga SOLO el correo. La clave nunca se rellena sola: en una
      // computadora compartida, un campo ya lleno es la sesión de alguien más.
      if (c) $('ck_g_correo').value = c.correo || '';
      $('ck_g_clave').value = '';
      $('ck_g_plan').value = (ident && ident.planName) || '';
      sugiereClave();
      track('modal_guardar_abierto');
      show($('ck_modal_guardar'));
    });
    if ($('ckLogoutBtn')) $('ckLogoutBtn').addEventListener('click', cerrarSesion);
    if ($('ckOpenBtn')) $('ckOpenBtn').addEventListener('click', function () { show($('ck_modal_abrir')); });
    // "✦ Nuevo" con modal propio: el confirm() del navegador era el otro punto
    // donde CroKiss dejaba de parecer CroKiss.
    if ($('ckNewBtn')) $('ckNewBtn').addEventListener('click', function () { show($('ck_modal_nuevo')); });
    if ($('ck_nv_close')) $('ck_nv_close').addEventListener('click', function () { hide($('ck_modal_nuevo')); });
    if ($('ck_nv_go')) $('ck_nv_go').addEventListener('click', function () {
      hide($('ck_modal_nuevo'));
      // soltar la identidad ANTES de sembrar el terreno: si no, el sync pisa
      // el proyecto guardado con el terreno vacío (decisión #7 de CLAUDE.md)
      if (ident) lastCreds = { correo: ident.correo, clave: '' };
      ident = null; saveIdent();
      show($('ck_modal_terreno'));
    });
    if ($('ck_modal_nuevo')) $('ck_modal_nuevo').addEventListener('click', function (e) {
      if (e.target === $('ck_modal_nuevo')) hide($('ck_modal_nuevo'));
    });

    if ($('ck_terreno_go'))    $('ck_terreno_go').addEventListener('click', function () { startTerrain($('ck_ancho').value, $('ck_fondo').value); });
    ['ck_ancho', 'ck_fondo'].forEach(function (id) {
      if ($(id)) $(id).addEventListener('input', dibujaLote);
    });
    dibujaLote();
    if ($('ck_terreno_abrir')) $('ck_terreno_abrir').addEventListener('click', function (e) { e.preventDefault(); hide($('ck_modal_terreno')); show($('ck_modal_abrir')); });
    if ($('ck_presets')) $('ck_presets').addEventListener('click', function (e) {
      var b = e.target.closest('[data-w]'); if (!b) return;
      $('ck_ancho').value = b.getAttribute('data-w'); $('ck_fondo').value = b.getAttribute('data-d');
      dibujaLote();
    });

    if ($('ck_borrar_link')) $('ck_borrar_link').addEventListener('click', function (e) {
      e.preventDefault();
      if ($('ck_b_correo')) $('ck_b_correo').value = ($('ck_g_correo').value || '').trim();
      show($('ck_modal_borrar'));
    });
    if ($('ck_b_close')) $('ck_b_close').addEventListener('click', function () { hide($('ck_modal_borrar')); });
    if ($('ck_b_go')) $('ck_b_go').addEventListener('click', submitBorrar);

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

  /* ---------------- modo compartir (solo lectura) ----------------
     ?plan=ID muestra el croquis sin barra, sin paleta y sin barra de info:
     es una vitrina, no un editor. Nunca expone el correo ni la clave del
     dueño (el backend no los devuelve sin credenciales). */
  function modoCompartir(planId) {
    document.body.classList.add('ck-solo-lectura');
    // ANTES de cargar nada: el motor deja de escribir en localStorage. Si no,
    // abrir un croquis compartido le borraría al visitante su propio borrador.
    if (ed.setSoloLectura) ed.setSoloLectura(true);
    var banda = document.createElement('div');
    banda.id = 'ck_banda';
    banda.innerHTML =
      '<span>Croquis hecho en <b>Cro&middot;Kiss</b></span>' +
      '<a href="./">Dibuja el tuyo gratis &rarr;</a>';
    document.body.insertBefore(banda, document.body.firstChild);

    get({ action: 'plan', id: planId, src: 'share' }).then(function (res) {
      if (res && res.ok && res.geom) {
        ed.loadGeom(res.geom);
        if (res.plan_name) {
          var t = document.createElement('span');
          t.className = 'ck-banda-nombre';
          t.textContent = res.plan_name;
          banda.insertBefore(t, banda.lastChild);
        }
        if (ed.zoomFit) ed.zoomFit();
      } else {
        banda.innerHTML = '<span>' + esc(msgError(res && res.error)) + '</span>' +
                          '<a href="./">Dibuja el tuyo gratis &rarr;</a>';
      }
    }).catch(function () {
      banda.innerHTML = '<span>No pudimos abrir este croquis.</span><a href="./">Dibuja el tuyo gratis &rarr;</a>';
    });
  }

  function boot(editor) {
    ed = editor;
    // modo vitrina: se decide ANTES de cualquier identidad o sincronización
    var soloLectura = new URLSearchParams(location.search).get('plan');
    if (soloLectura) { modoCompartir(soloLectura); return; }
    loadIdent();
    if (ident) lastCreds = { correo: ident.correo, clave: ident.clave };
    wire();

    var openId = new URLSearchParams(location.search).get('open');

    actualizaSesionUI();

    // El pill se recorta en el teléfono para que la barra quepa en 2 filas:
    // un toque lo lee completo en un toast. Y aria-live para lector de pantalla.
    var pill = $('ck_status');
    if (pill) {
      pill.setAttribute('role', 'status');
      pill.setAttribute('aria-live', 'polite');
      pill.style.cursor = 'pointer';
      pill.addEventListener('click', function () { if (pill.textContent) toast(pill.textContent); });
    }

    if (openId) {
      openProject(openId);                  // desde el enlace del correo (sin clave en la URL)
    } else if (sesionViva()) {
      lastSeen = geomStr(); lastPushed = '';
      setStatus('Guardado en la nube ✓', 'ok');
      scheduleSync();                       // sube cambios locales pendientes de la sesión pasada
    } else if (ident) {
      // El proyecto sigue reclamado, pero la clave murió al cerrar el navegador
      // (a propósito). Se edita en local hasta que la reescriba al guardar.
      lastSeen = geomStr(); lastPushed = '';
      setStatus('Escribe tu clave para seguir guardando en la nube', 'warn');
    } else if (localStorage.getItem(GEOM_KEY)) {
      lastSeen = geomStr();
      setStatus('Borrador local — guarda con tu clave', 'warn');
    } else {
      setStatus('Borrador local', 'warn');
      fresh();
    }

    setInterval(poll, CONFIG.POLL_MS);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') { beacon(); evBeacon(); } });
    window.addEventListener('pagehide', function () { beacon(); evBeacon(); });
  }

  window.CroKiss = { boot: boot, startTerrain: startTerrain, track: track, contactURL: contactURL };
})();
