/***** CroKiss — Backend (Google Apps Script) ********************************
 * Base de datos en Google Sheets para el editor de planos CroKiss.
 *   doPost  -> guardar (mode:'save', manda correo) o sincronizar (mode:'sync')
 *   doGet   -> listar proyectos (action:'list') o abrir uno (action:'plan')
 *
 * Modelo: correo + clave = tu "cuenta". Bajo ella puede haber VARIOS
 * proyectos (cada uno con su plan_id). Guardar con plan_id actualiza ese
 * proyecto; sin plan_id, si el nombre ya existe lo reanuda, si no, crea uno.
 *
 * El POST llega como text/plain para evitar el "preflight" de CORS.
 *
 * ---------------------------------------------------------------------------
 * P1 (2026-07-25) — backend a escala + blindaje de rutas:
 *  · LECTURAS QUIRÚRGICAS: ninguna ruta lee ya la columna geom_json para
 *    buscar. Se leen solo las columnas de metadatos (1..10) y el plan_id se
 *    localiza con createTextFinder().matchEntireCell(true) sobre SU columna.
 *    El blob geom_json se lee de UNA celda, solo al abrir un plano concreto.
 *    Antes cada request arrastraba hasta 200 KB por fila: el techo real eran
 *    ~1.000-2.000 filas.
 *  · El LOCK ya solo envuelve la escritura en la hoja. Validaciones y correo
 *    quedan fuera (el correo tardaba segundos con el lock tomado).
 *  · MAX_GEOM_BYTES = 45.000 (el límite real de Sheets es ~50.000 caracteres
 *    por celda; con 200.000 el plano pasaba validación y REVENTABA al
 *    escribir, dejando al cliente en reintento infinito = lead perdido).
 *  · RATE-LIMIT en todas las rutas con credenciales, con claves de caché
 *    hasheadas (MD5 base64, 24 chars) para no pasarse de los 250 chars.
 *  · Errores OPACOS al cliente ('error_interno'); el detalle va a
 *    console.error, visible en Apps Script → Ejecuciones.
 *  · Mantenimiento: podarHistorial() y healthPing() (ver TRIGGERS abajo).
 * ---------------------------------------------------------------------------
 *
 * ============================ TRIGGERS (crear UNA vez) ======================
 * En el editor de Apps Script → menú izquierdo → Activadores (reloj) →
 * "+ Añadir activador":
 *
 *   1) Función: podarHistorial · Implementación: Principal ·
 *      Origen: Según tiempo · Tipo: Temporizador diario · ej. 3-4 a.m.
 *      (conserva 20 versiones por plano y borra lo que pase de 90 días)
 *
 *   2) Función: healthPing · Implementación: Principal ·
 *      Origen: Según tiempo · Tipo: Temporizador por horas · Cada hora
 *      (si la hoja deja de responder, te avisa por correo)
 *
 *   3) Función: respaldoSemanal (si existe en tu copia) · Temporizador
 *      semanal · lunes 4-5 a.m.
 * ===========================================================================
 ***************************************************************************/

var CONFIG = {
  SHEET_PLANOS:     'Planos',      // estado actual: 1 fila por proyecto
  SHEET_HISTORIAL:  'Historial',   // bitácora: solo en guardado explícito
  SITE_BASE:        'https://alexpueblag.github.io/crokiss/',  // tu URL de GitHub Pages
  EDITOR_FILE:      'index.html',
  REMITENTE_NOMBRE: 'CroKiss · Aurum Arquitectos',
  ALERTA_CORREO:    'direccion@aurumarquitectos.com',   // a quién avisa healthPing()

  // Tope del plano. El límite duro de Sheets es ~50.000 caracteres por celda:
  // por encima, setValues() lanza excepción y el guardado se pierde en silencio.
  MAX_GEOM_BYTES:   45000,
  MAX_CORREO_CHARS: 120,           // largo máximo del correo
  MIN_CLAVE:        6,             // mínimo de clave — SOLO para cuentas nuevas
  MAX_CLAVE:        40,            // máximo de clave

  MAX_POR_CORREO:   60,            // máx. proyectos por correo (anti-abuso)
  MAX_EMAIL_CORREO: 3,             // máx. correos a un mismo destinatario / ventana 6 h
  MAX_EMAIL_DIA:    80,            // tope global de correos / ventana 6 h (cuota MailApp)
  MAX_LIST_CORREO:  40,            // máx. consultas 'list' por correo / hora
  MAX_PLAN_ID:      30,            // máx. aperturas de un mismo plan_id / hora
  MAX_SAVE_CORREO:  30,            // máx. guardados por correo / hora

  HIST_VERSIONES:   20,            // versiones a conservar por plan_id
  HIST_DIAS:        90             // antigüedad máxima en Historial
};

var HEADERS = ['ts','plan_id','client_id','nombre','correo','clave',
               'plan_name','version','marketing','source','geom_json'];

/* ============================ ENTRADAS ============================ */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var action = p.action || 'list';

    if (action === 'ping') return _json({ ok: true, pong: true });

    if (action === 'plan') {                 // abrir un proyecto por id
      var id = String(p.id || '').slice(0, 60);
      if (!id) return _json({ ok: false, error: 'no_encontrado' });
      // Anti-abuso: sin esto, cualquiera agota la cuota diaria golpeando action=plan.
      if (!_rateOk(_ckey('pl_', id), CONFIG.MAX_PLAN_ID, 3600))
        return _json({ ok: false, error: 'demasiados_intentos' });

      var sh = _sheet(CONFIG.SHEET_PLANOS);
      var meta = _meta(sh);                                  // SIN geom_json
      var rowIdx = _rowByPlanId(sh, meta, id);
      if (rowIdx < 0) return _json({ ok: false, error: 'no_encontrado' });
      var row = _rowObj(meta.data[rowIdx - 2], meta.col);

      var pCorreo = String(p.correo || '').toLowerCase();
      var pClave  = String(p.clave  || '');
      var authed = !!(pCorreo || pClave) &&
        String(row.correo).toLowerCase() === pCorreo &&
        String(row.clave) === pClave;
      if ((pCorreo || pClave) && !authed) return _json({ ok: false, error: 'no_autorizado' });

      // El blob se lee AQUÍ y solo aquí: una celda, no la hoja entera.
      var geomStr = _readGeom(sh, meta, rowIdx);
      var geom;
      try { geom = JSON.parse(geomStr); } catch (err) {
        console.error('geom_json corrupto en fila ' + rowIdx + ': ' + err);
        return _json({ ok: false, error: 'no_encontrado' });
      }
      // Seguridad: nunca devolvemos la clave; el correo solo si el que pregunta ya la sabe.
      return _json({ ok: true, geom: geom, plan_name: row.plan_name,
        version: row.version, plan_id: row.plan_id, correo: authed ? row.correo : undefined });
    }

    // 'list' (default): proyectos que coinciden con correo + clave (anti-fuerza-bruta)
    var lc = String(p.correo || '').toLowerCase();
    if (lc && !_rateOk(_ckey('ls_', lc), CONFIG.MAX_LIST_CORREO, 3600))
      return _json({ ok: false, error: 'demasiados_intentos' });
    var items = _listByCredentials(p.correo, p.clave);
    return _json({ ok: true, count: items.length, items: items });

  } catch (err) {
    console.error('doGet: ' + (err && err.stack ? err.stack : err));
    return _json({ ok: false, error: 'error_interno' });
  }
}

function doPost(e) {
  try {
    /* ---- validación: FUERA del lock ---- */
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (body.website) return _json({ ok: false, error: 'spam' });   // honeypot

    var mode   = body.mode || 'save';
    var correo = String(body.correo || '').trim().toLowerCase();
    var clave  = String(body.clave  || '').trim();
    if (!_validEmail(correo) || correo.length > CONFIG.MAX_CORREO_CHARS)
      return _json({ ok: false, error: 'correo_invalido' });
    if (!clave || clave.length > CONFIG.MAX_CLAVE)
      return _json({ ok: false, error: 'clave_invalida' });

    var geom = body.geom;
    if (!geom || !geom.walls) return _json({ ok: false, error: 'plano_invalido' });
    var geomStr = JSON.stringify(geom);
    if (geomStr.length > CONFIG.MAX_GEOM_BYTES) return _json({ ok: false, error: 'plano_muy_grande' });

    // Anti-abuso de escritura (antes solo 'list' tenía freno).
    if (!_rateOk(_ckey('sv_', correo), CONFIG.MAX_SAVE_CORREO, 3600))
      return _json({ ok: false, error: 'demasiados_intentos' });

    /* ---- escritura en la hoja: DENTRO del lock ---- */
    var lock = LockService.getScriptLock();
    var r;
    try {
      lock.waitLock(20000);
      r = _guardarFila(mode, correo, clave, geomStr, body);
    } finally {
      try { lock.releaseLock(); } catch (_) {}
    }
    if (r.error) return _json({ ok: false, error: r.error });

    /* ---- correo: FUERA del lock (tarda segundos y no debe bloquear a nadie) ---- */
    var emailed = false;
    if (mode === 'save' && (r.isNew || body.sendEmail) && _canEmail(correo)) {
      try { _sendPlanEmail(correo, r.nombre, r.planName, clave, r.planId); emailed = true; }
      catch (err) { console.error('correo a ' + correo + ': ' + err); }
    }

    return _json({ ok: true, plan_id: r.planId, version: r.version, isNew: r.isNew, emailed: emailed });

  } catch (err) {
    console.error('doPost: ' + (err && err.stack ? err.stack : err));
    return _json({ ok: false, error: 'error_interno' });
  }
}

/* Escritura de la fila. Se llama SIEMPRE con el lock tomado y nunca lee geom_json. */
function _guardarFila(mode, correo, clave, geomStr, body) {
  var sh = _sheet(CONFIG.SHEET_PLANOS);
  var meta = _meta(sh);
  var col = meta.col;
  var planName = String(body.plan_name || 'Mi proyecto').slice(0, 80);

  // ---- localizar la fila destino (sin arrastrar el blob) ----
  var rowIdx = -1, existing = null;
  var wantId = String(body.plan_id || '').slice(0, 60);
  if (wantId) {                                  // actualizar un proyecto concreto
    rowIdx = _rowByPlanId(sh, meta, wantId);
    if (rowIdx > 0) existing = _rowObj(meta.data[rowIdx - 2], col);
    if (existing && (String(existing.correo).toLowerCase() !== correo || String(existing.clave) !== clave))
      return { error: 'no_autorizado' };          // seguridad: dueño correcto
  } else {                                       // sin id: reanudar por nombre o crear
    for (var j = 0; j < meta.data.length; j++)
      if (String(meta.data[j][col.correo]).toLowerCase() === correo &&
          String(meta.data[j][col.clave]) === clave &&
          String(meta.data[j][col.plan_name]) === planName) {
        rowIdx = j + 2; existing = _rowObj(meta.data[j], col); break;
      }
  }
  var isNew = !existing;

  if (mode === 'sync' && isNew) return { error: 'no_existe' };      // sync no crea

  // El mínimo de clave aplica SOLO a cuentas nuevas: una cuenta vieja con
  // clave corta debe poder seguir entrando (no se deja fuera a ningún lead).
  if (isNew && clave.length < CONFIG.MIN_CLAVE) return { error: 'clave_corta' };

  if (isNew) {                                   // tope por correo (anti-abuso)
    var count = 0;
    for (var k = 0; k < meta.data.length; k++)
      if (String(meta.data[k][col.correo]).toLowerCase() === correo) count++;
    if (count >= CONFIG.MAX_POR_CORREO) return { error: 'limite_por_correo' };
  }

  var now      = new Date();
  var planId   = existing ? existing.plan_id : _newId();
  var version  = existing ? (Number(existing.version) || 0) + 1 : 1;
  var nombre   = String(body.nombre    || (existing && existing.nombre)    || '').slice(0, 80);
  var clientId = String(body.client_id || (existing && existing.client_id) || '').slice(0, 60);
  var marketing = body.marketing ? 'si' : ((existing && existing.marketing) || 'no');

  var rowValues = _orderRow({
    ts: now, plan_id: planId, client_id: _safeCell(clientId), nombre: _safeCell(nombre), correo: _safeCell(correo),
    clave: _safeCell(clave), plan_name: _safeCell(planName), version: version, marketing: marketing,
    source: 'crokiss-web', geom_json: geomStr
  }, meta.header);

  if (rowIdx > 0) sh.getRange(rowIdx, 1, 1, rowValues.length).setValues([rowValues]);
  else            sh.appendRow(rowValues);

  // Historial SOLO en guardado explícito (no en cada autoguardado)
  if (mode === 'save') {
    try {
      var hist = _sheet(CONFIG.SHEET_HISTORIAL);
      if (hist.getLastRow() === 0) hist.appendRow(['ts','plan_id','plan_name','correo','version','geom_json']);
      hist.appendRow([now, planId, planName, correo, version, geomStr]);
    } catch (err) { console.error('historial: ' + err); }
  }

  return { planId: planId, version: version, isNew: isNew, nombre: nombre, planName: planName };
}

/* ============================ HELPERS ============================ */

function _sheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); }
  if (name === CONFIG.SHEET_PLANOS && sh.getLastRow() === 0) sh.appendRow(HEADERS);
  return sh;
}

/* Lee SOLO los metadatos (todas las columnas ANTES de geom_json).
   Devuelve { header, col, data, lastRow, nMeta }, donde data[0] es la fila 2
   de la hoja. El blob nunca entra aquí: esta es la mejora de escala de P1. */
function _meta(sh) {
  var lastRow = sh.getLastRow();
  var lastCol = Math.max(sh.getLastColumn(), HEADERS.length);
  var header  = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var col     = _colIndex(header);
  // nMeta = columnas hasta justo antes de geom_json (en el esquema estándar, 10).
  var gi = col.geom_json;
  var nMeta = (gi === undefined || gi < 0) ? lastCol : gi;
  if (nMeta < 1) nMeta = 1;
  var data = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, nMeta).getValues() : [];
  return { header: header, col: col, data: data, lastRow: lastRow, nMeta: nMeta };
}

/* Localiza la fila de un plan_id con TextFinder sobre SU columna (rápido y
   sin traerse la hoja). Si TextFinder no está disponible, cae a barrido
   lineal sobre los metadatos YA leídos (nunca vuelve a la hoja). */
function _rowByPlanId(sh, meta, id) {
  id = String(id || '');
  if (!id || meta.lastRow < 2) return -1;
  var c = meta.col.plan_id;
  if (c === undefined) return -1;
  try {
    var found = sh.getRange(2, c + 1, meta.lastRow - 1, 1)
                  .createTextFinder(id).matchEntireCell(true).findNext();
    if (found) return found.getRow();
  } catch (err) {
    console.error('TextFinder no disponible, barrido lineal: ' + err);
  }
  for (var i = 0; i < meta.data.length; i++)
    if (String(meta.data[i][c]) === id) return i + 2;
  return -1;
}

/* Lee el blob de UNA celda concreta. */
function _readGeom(sh, meta, rowIdx) {
  var gi = meta.col.geom_json;
  if (gi === undefined) return '';
  return String(sh.getRange(rowIdx, gi + 1, 1, 1).getValue() || '');
}

function _colIndex(headerRow) {
  var c = {}; headerRow.forEach(function (h, i) { c[String(h).trim()] = i; }); return c;
}
function _rowObj(row, col) {
  var o = {}; Object.keys(col).forEach(function (k) { o[k] = row[col[k]]; }); return o;
}
function _orderRow(obj, headerRow) {
  return headerRow.map(function (h) { var k = String(h).trim(); return obj[k] !== undefined ? obj[k] : ''; });
}
function _listByCredentials(correo, clave) {
  correo = String(correo || '').toLowerCase(); clave = String(clave || '');
  var out = [];
  if (!correo || !clave) return out;
  var sh = _sheet(CONFIG.SHEET_PLANOS), meta = _meta(sh), col = meta.col;   // sin geom_json
  for (var i = 0; i < meta.data.length; i++)
    if (String(meta.data[i][col.correo]).toLowerCase() === correo && String(meta.data[i][col.clave]) === clave)
      out.push({ plan_id: String(meta.data[i][col.plan_id]),
                 plan_name: String(meta.data[i][col.plan_name] || 'Mi proyecto'),
                 version: Number(meta.data[i][col.version]) || 1,
                 ts: meta.data[i][col.ts] });
  out.sort(function (a, b) { return new Date(b.ts) - new Date(a.ts); });   // más reciente primero
  return out;
}
function _newId() { try { return 'ck' + Utilities.getUuid().replace(/-/g, '').slice(0, 18); } catch (e) { return 'ck' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); } }
function _validEmail(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '')); }
function _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
// Anti-inyección de fórmulas en Sheets: si el texto empieza con = + - @, lo neutraliza (la ' no altera el valor leído).
function _safeCell(v) { var s = String(v == null ? '' : v); return /^[=+\-@]/.test(s) ? ("'" + s) : s; }

/* Clave de CacheService SIEMPRE hasheada: un correo largo o un plan_id raro
   podían pasarse del tope de 250 caracteres y tirar el contador entero. */
function _ckey(prefijo, valor) {
  var s = String(valor || '');
  try {
    return prefijo + Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8));
  } catch (e) {
    return prefijo + s.slice(0, 200);        // degradación: recorta para no exceder el tope
  }
}

/* Throttle de correo por destinatario y global (ventana 6 h) + cuota de MailApp.
   FAIL-CLOSED: si la caché falla, NO se manda correo. Es seguro para el lead
   porque el front muestra la clave en pantalla cuando el correo no sale. */
function _canEmail(correo) {
  try {
    if (MailApp.getRemainingDailyQuota() < 5) return false;
    var c = CacheService.getScriptCache();
    var kDay = 'em_day', kPer = _ckey('em_', correo);
    var day = Number(c.get(kDay) || '0'), per = Number(c.get(kPer) || '0');
    if (day >= CONFIG.MAX_EMAIL_DIA || per >= CONFIG.MAX_EMAIL_CORREO) return false;
    c.put(kDay, String(day + 1), 21600); c.put(kPer, String(per + 1), 21600);
    return true;
  } catch (e) { console.error('_canEmail: ' + e); return false; }
}

/* Contador con tope por clave/ventana. FAIL-CLOSED por diseño: si la caché
   falla, se rechaza en vez de dejar la puerta abierta. */
function _rateOk(key, max, ttl) {
  try {
    var c = CacheService.getScriptCache();
    var n = Number(c.get(key) || '0');
    if (n >= max) return false;
    c.put(key, String(n + 1), ttl);
    return true;
  } catch (e) { console.error('_rateOk: ' + e); return false; }
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function _sendPlanEmail(correo, nombre, planName, clave, planId) {
  var editorUrl = CONFIG.SITE_BASE + CONFIG.EDITOR_FILE + '?open=' + encodeURIComponent(planId);
  var saludo = nombre ? ('Hola ' + _esc(nombre)) : 'Hola';
  var html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;color:#16181d">' +
      '<div style="background:#16181d;color:#fff;padding:22px 24px;border-radius:12px 12px 0 0">' +
        '<div style="font-size:22px;letter-spacing:1px;font-weight:700">Cro&middot;Kiss</div>' +
        '<div style="font-size:12px;letter-spacing:2px;opacity:.8">EL PRIMER BESO CON TU PROYECTO</div>' +
      '</div>' +
      '<div style="border:1px solid #e2e0db;border-top:0;border-radius:0 0 12px 12px;padding:24px">' +
        '<p>' + saludo + ', tu proyecto <b>' + _esc(planName) + '</b> qued&oacute; guardado.</p>' +
        '<p>Para volver a editarlo cuando quieras, tu clave es:</p>' +
        '<p style="font-size:20px;font-weight:700;letter-spacing:2px;background:#f4f2ee;border:1px dashed #c75b39;border-radius:8px;padding:12px 16px;text-align:center;color:#c75b39">' + _esc(clave) + '</p>' +
        '<p style="text-align:center;margin:22px 0">' +
          '<a href="' + editorUrl + '" style="display:inline-block;background:#c75b39;color:#fff;text-decoration:none;padding:13px 22px;border-radius:9px;font-weight:700">Abrir mi proyecto</a>' +
        '</p>' +
        '<p style="font-size:13px;color:#6b6256">Tambi&eacute;n puedes entrar a CroKiss y usar &ldquo;Abrir con clave&rdquo; con tu correo y esta clave.</p>' +
        '<hr style="border:0;border-top:1px solid #e2e0db;margin:18px 0">' +
        '<p style="font-size:12px;color:#6b6256">&iquest;Quieres llevar tu idea al siguiente nivel? En Aurum Arquitectos y Yodesarrollo te ayudamos a hacerla realidad. Responde este correo y platicamos.</p>' +
      '</div>' +
    '</div>';
  MailApp.sendEmail({ to: correo, name: CONFIG.REMITENTE_NOMBRE,
    subject: 'Tu proyecto en CroKiss — tu clave para volver', htmlBody: html });
}

/* ======================== MANTENIMIENTO (triggers) ======================== */

/* Poda del Historial: conserva las últimas CONFIG.HIST_VERSIONES por plan_id
   y borra todo lo que pase de CONFIG.HIST_DIAS. Sin esto la pestaña crece sin
   tope (cada guardado explícito escribe una copia completa del plano).
   Trigger sugerido: diario, 3-4 a.m. */
function podarHistorial() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(CONFIG.SHEET_HISTORIAL);
    if (!sh) return 0;
    var lastRow = sh.getLastRow();
    if (lastRow < 2) return 0;

    // Solo las 5 primeras columnas (ts, plan_id, plan_name, correo, version).
    // geom_json es la 6ª y NO se lee: podar no debe costar megabytes.
    var datos = sh.getRange(2, 1, lastRow - 1, 5).getValues();
    var corte = new Date().getTime() - CONFIG.HIST_DIAS * 24 * 3600 * 1000;
    var vistos = {}, borrar = [];

    // De la fila más nueva a la más vieja: las primeras N de cada plan se quedan.
    for (var i = datos.length - 1; i >= 0; i--) {
      var fila = i + 2;
      var ts = new Date(datos[i][0]).getTime();
      var pid = String(datos[i][1] || '');
      if (!isNaN(ts) && ts < corte) { borrar.push(fila); continue; }
      vistos[pid] = (vistos[pid] || 0) + 1;
      if (vistos[pid] > CONFIG.HIST_VERSIONES) borrar.push(fila);
    }

    borrar.sort(function (a, b) { return b - a; });      // de abajo hacia arriba
    for (var k = 0; k < borrar.length; k++) sh.deleteRow(borrar[k]);
    console.log('podarHistorial: ' + borrar.length + ' filas borradas de ' + (lastRow - 1));
    return borrar.length;
  } catch (err) {
    console.error('podarHistorial: ' + (err && err.stack ? err.stack : err));
    return -1;
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/* Latido de salud: hace la lectura MÍNIMA posible y avisa por correo si la
   hoja dejó de responder. Trigger sugerido: cada hora.
   Solo manda un aviso cada 6 h para no inundar el buzón. */
function healthPing() {
  try {
    var sh = _sheet(CONFIG.SHEET_PLANOS);
    var n = sh.getLastRow();
    sh.getRange(1, 1, 1, 1).getValue();          // lectura real, mínima
    console.log('healthPing OK · filas: ' + n);
    return true;
  } catch (err) {
    console.error('healthPing FALLÓ: ' + (err && err.stack ? err.stack : err));
    try {
      var c = CacheService.getScriptCache();
      if (!c.get('hp_avisado')) {
        c.put('hp_avisado', '1', 21600);         // máx. 1 aviso cada 6 h
        MailApp.sendEmail({
          to: CONFIG.ALERTA_CORREO,
          subject: 'CroKiss: el backend no responde',
          body: 'healthPing() falló a las ' + new Date() +
                '\n\nDetalle: ' + err +
                '\n\nRevisa Apps Script → Ejecuciones.'
        });
      }
    } catch (e2) { console.error('healthPing no pudo avisar: ' + e2); }
    return false;
  }
}

/* Corre esto UNA vez para crear las pestañas y autorizar permisos. */
function setup() { _sheet(CONFIG.SHEET_PLANOS); _sheet(CONFIG.SHEET_HISTORIAL); }
