/***** CroKiss — Backend (Google Apps Script) ********************************
 * Base de datos en Google Sheets para el editor de planos CroKiss.
 *   doPost  -> guardar (mode:'save', manda correo) o sincronizar (mode:'sync')
 *   doGet   -> abrir por correo+clave (action:'open') o por id (action:'plan')
 *
 * El POST llega como text/plain para evitar el "preflight" de CORS
 * (el mismo truco que ya usas en Aurum Board).
 *
 * >>> ANTES DE PUBLICAR: pega tu URL de GitHub Pages en CONFIG.SITE_BASE. <<<
 ***************************************************************************/

var CONFIG = {
  SHEET_PLANOS:     'Planos',      // estado actual: 1 fila por proyecto
  SHEET_HISTORIAL:  'Historial',   // bitácora append-only (cada versión)
  SITE_BASE:        'https://USUARIO.github.io/REPO/',  // <-- TU URL (con / al final)
  EDITOR_FILE:      'index.html',
  REMITENTE_NOMBRE: 'CroKiss · Aurum Arquitectos',
  MAX_GEOM_BYTES:   200000,        // tope del plano (anti-abuso)
  MAX_POR_CORREO:   60             // máx. proyectos por correo (anti-abuso)
};

var HEADERS = ['ts','plan_id','client_id','nombre','correo','clave',
               'plan_name','version','marketing','source','geom_json'];

/* ============================ ENTRADAS ============================ */

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var action = p.action || 'open';

    if (action === 'ping') return _json({ ok: true, pong: true });

    if (action === 'plan') {                 // abrir por id (link del correo)
      var byId = _findById(p.id);
      if (!byId) return _json({ ok: false, error: 'no_encontrado' });
      return _json({ ok: true, geom: JSON.parse(byId.geom_json),
        plan_name: byId.plan_name, version: byId.version,
        correo: byId.correo, clave: byId.clave, plan_id: byId.plan_id });
    }

    var r = _findByCredentials(p.correo, p.clave);   // abrir por correo+clave
    if (!r) return _json({ ok: false, error: 'no_encontrado' });
    return _json({ ok: true, geom: JSON.parse(r.geom_json),
      plan_name: r.plan_name, version: r.version, plan_id: r.plan_id });

  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (body.website) return _json({ ok: false, error: 'spam' });   // honeypot

    var mode   = body.mode || 'save';
    var correo = String(body.correo || '').trim().toLowerCase();
    var clave  = String(body.clave  || '').trim();
    if (!_validEmail(correo))            return _json({ ok: false, error: 'correo_invalido' });
    if (!clave || clave.length > 40)     return _json({ ok: false, error: 'clave_invalida' });

    var geom = body.geom;
    if (!geom || !geom.walls)            return _json({ ok: false, error: 'plano_invalido' });
    var geomStr = JSON.stringify(geom);
    if (geomStr.length > CONFIG.MAX_GEOM_BYTES) return _json({ ok: false, error: 'plano_muy_grande' });

    var sh = _sheet(CONFIG.SHEET_PLANOS);
    var data = sh.getDataRange().getValues();
    var col = _colIndex(data[0]);

    var rowIdx = -1, existing = null;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][col.correo]).toLowerCase() === correo &&
          String(data[i][col.clave]) === clave) {
        rowIdx = i + 1; existing = _rowObj(data[i], col); break;
      }
    }
    var isNew = !existing;

    // 'sync' nunca crea ni manda correo: si no existe, pide guardar.
    if (mode === 'sync' && isNew) return _json({ ok: false, error: 'no_existe' });

    if (isNew) {                              // tope por correo (anti-abuso)
      var count = 0;
      for (var j = 1; j < data.length; j++)
        if (String(data[j][col.correo]).toLowerCase() === correo) count++;
      if (count >= CONFIG.MAX_POR_CORREO) return _json({ ok: false, error: 'limite_por_correo' });
    }

    var now      = new Date();
    var planId   = existing ? existing.plan_id : _newId();
    var version  = existing ? (Number(existing.version) || 0) + 1 : 1;
    var planName = String(body.plan_name || (existing && existing.plan_name) || 'Mi proyecto').slice(0, 80);
    var nombre   = String(body.nombre    || (existing && existing.nombre)    || '').slice(0, 80);
    var clientId = String(body.client_id || (existing && existing.client_id) || '').slice(0, 60);
    var marketing = body.marketing ? 'si' : ((existing && existing.marketing) || 'no');

    var rowValues = _orderRow({
      ts: now, plan_id: planId, client_id: clientId, nombre: nombre, correo: correo,
      clave: clave, plan_name: planName, version: version, marketing: marketing,
      source: 'crokiss-web', geom_json: geomStr
    }, data[0]);

    if (rowIdx > 0) sh.getRange(rowIdx, 1, 1, rowValues.length).setValues([rowValues]);
    else            sh.appendRow(rowValues);

    try {                                     // bitácora append-only
      var hist = _sheet(CONFIG.SHEET_HISTORIAL);
      if (hist.getLastRow() === 0) hist.appendRow(['ts','plan_id','correo','version','geom_json']);
      hist.appendRow([now, planId, correo, version, geomStr]);
    } catch (_) {}

    var emailed = false;                      // correo solo al guardar (1ra vez o si lo piden)
    if (mode === 'save' && (isNew || body.sendEmail)) {
      try { _sendPlanEmail(correo, nombre, planName, clave, planId); emailed = true; } catch (_) {}
    }

    return _json({ ok: true, plan_id: planId, version: version, isNew: isNew, emailed: emailed });

  } catch (err) {
    return _json({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/* ============================ HELPERS ============================ */

function _sheet(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); }
  if (name === CONFIG.SHEET_PLANOS && sh.getLastRow() === 0) sh.appendRow(HEADERS);
  return sh;
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
function _findByCredentials(correo, clave) {
  correo = String(correo || '').toLowerCase(); clave = String(clave || '');
  if (!correo || !clave) return null;
  var sh = _sheet(CONFIG.SHEET_PLANOS), data = sh.getDataRange().getValues(), col = _colIndex(data[0]);
  for (var i = 1; i < data.length; i++)
    if (String(data[i][col.correo]).toLowerCase() === correo && String(data[i][col.clave]) === clave)
      return _rowObj(data[i], col);
  return null;
}
function _findById(id) {
  id = String(id || ''); if (!id) return null;
  var sh = _sheet(CONFIG.SHEET_PLANOS), data = sh.getDataRange().getValues(), col = _colIndex(data[0]);
  for (var i = 1; i < data.length; i++)
    if (String(data[i][col.plan_id]) === id) return _rowObj(data[i], col);
  return null;
}
function _newId() { return 'ck' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function _validEmail(s) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '')); }
function _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
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

/* Corre esto UNA vez desde el editor de Apps Script para crear las
   pestañas y autorizar permisos (incluido el envío de correo). */
function setup() { _sheet(CONFIG.SHEET_PLANOS); _sheet(CONFIG.SHEET_HISTORIAL); }
