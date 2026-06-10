/***** CroKiss · Aurum Arquitectos — Backend (Google Apps Script) ************
 * Base de datos en Google Sheets para el editor de planos CroKiss.
 *   doPost  -> guardar (mode:'save', manda correo) o sincronizar (mode:'sync')
 *   doGet   -> abrir por correo+clave (action:'open') o por id (action:'plan')
 *
 * El POST llega como text/plain para evitar el "preflight" de CORS
 * (el mismo truco que ya usas en Aurum Board).
 *
 * Códigos de error que emite este backend (el front los mapea a mensajes):
 *   'no_existe', 'clave_incorrecta', 'muy_grande', 'clave_larga',
 *   'tope_alcanzado', 'spam'
 *
 * ====================== PASOS DE DESPLIEGUE (a mano) ======================
 * Este archivo NO se despliega solo. Para publicar cambios:
 *   1. Abre el proyecto de Apps Script vinculado a la hoja "CroKiss — Planos".
 *   2. ANTES de pegar: compara con el código desplegado (el Code.gs local
 *      puede ir detrás de producción, p. ej. action:'list' del selector);
 *      si producción tiene funciones que aquí no están, consérvalas.
 *   3. Pega este archivo completo sobre Code.gs y guarda (Ctrl+S).
 *   4. Implementar → Gestionar implementaciones → en la implementación
 *      EXISTENTE pulsa el lápiz (editar) → Versión: "Versión nueva" →
 *      Implementar.
 *   5. NUNCA crees una implementación nueva: cambiaría la URL /exec y
 *      rompería el front y todos los enlaces ?open=ID ya enviados por correo.
 *   6. Para el respaldo semanal: ver instrucciones sobre respaldoSemanal().
 * ==========================================================================
 *
 * >>> ANTES DE PUBLICAR: pega tu URL de GitHub Pages en CONFIG.SITE_BASE. <<<
 ***************************************************************************/

var CONFIG = {
  SHEET_PLANOS:     'Planos',      // estado actual: 1 fila por proyecto
  SHEET_HISTORIAL:  'Historial',   // bitácora append-only (solo en 'save')
  SITE_BASE:        'https://alexpueblag.github.io/crokiss/',  // URL pública del editor (con / al final)
  EDITOR_FILE:      'index.html',
  REMITENTE_NOMBRE: 'CroKiss · Aurum Arquitectos',
  MAX_GEOM_BYTES:   45000,         // tope del plano (la celda de Sheets admite ~50k chars)
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
      if (!byId) return _json({ ok: false, error: 'no_existe' });
      // OJO: NUNCA devolver la clave aquí (el enlace ?open=ID es público;
      // el front pide la clave aparte para reactivar el guardado en nube).
      return _json({ ok: true, geom: JSON.parse(byId.geom_json),
        nombre: byId.nombre, correo: byId.correo,
        plan_name: byId.plan_name, version: byId.version, plan_id: byId.plan_id });
    }

    // abrir por correo+clave
    var correo = String(p.correo || '').trim().toLowerCase();
    var clave  = String(p.clave  || '').trim();
    var b = _findByCredentials(correo, clave);
    if (!b.obj) return _json({ ok: false, error: b.correoExiste ? 'clave_incorrecta' : 'no_existe' });
    return _json({ ok: true, geom: JSON.parse(b.obj.geom_json),
      plan_name: b.obj.plan_name, version: b.obj.version, plan_id: b.obj.plan_id });

  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    /* ---- 1) Parseo y validaciones: FUERA del lock (no tocan la hoja) ---- */
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (body.website) return _json({ ok: false, error: 'spam' });   // honeypot

    var mode   = body.mode || 'save';
    var correo = String(body.correo || '').trim().toLowerCase();
    var clave  = String(body.clave  || '').trim();
    if (!_validEmail(correo))        return _json({ ok: false, error: 'no_existe' });
    if (!clave)                      return _json({ ok: false, error: 'clave_incorrecta' });
    if (clave.length > 40)           return _json({ ok: false, error: 'clave_larga' });

    var geom = body.geom;
    if (!geom || !geom.walls)        return _json({ ok: false, error: 'plano_invalido' });
    var geomStr = JSON.stringify(geom);
    if (geomStr.length > CONFIG.MAX_GEOM_BYTES) return _json({ ok: false, error: 'muy_grande' });

    /* ---- 2) Sección crítica: SOLO lectura/escritura de la hoja ---- */
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    var planId, version, isNew, nombre, planName;
    try {
      var sh = _sheet(CONFIG.SHEET_PLANOS);
      var b = _findByCredentials(correo, clave, sh);   // lee solo columnas correo/clave
      var existing = b.obj;
      isNew = !existing;

      // 'sync' nunca crea ni manda correo: si no existe, pide guardar.
      if (mode === 'sync' && isNew) return _json({ ok: false, error: 'no_existe' });

      // tope por correo (anti-abuso); b.correoCount ya viene del mismo barrido
      if (isNew && b.correoCount >= CONFIG.MAX_POR_CORREO)
        return _json({ ok: false, error: 'tope_alcanzado' });

      var now = new Date();
      planId   = existing ? existing.plan_id : _newId();
      version  = existing ? (Number(existing.version) || 0) + 1 : 1;
      planName = String(body.plan_name || (existing && existing.plan_name) || 'Mi proyecto').slice(0, 80);
      nombre   = String(body.nombre    || (existing && existing.nombre)    || '').slice(0, 80);
      var clientId  = String(body.client_id || (existing && existing.client_id) || '').slice(0, 60);
      var marketing = body.marketing ? 'si' : ((existing && existing.marketing) || 'no');

      var rowValues = _orderRow({
        ts: now, plan_id: planId, client_id: clientId, nombre: nombre, correo: correo,
        clave: clave, plan_name: planName, version: version, marketing: marketing,
        source: 'crokiss-web', geom_json: geomStr
      }, sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]);

      if (b.rowIdx > 0) sh.getRange(b.rowIdx, 1, 1, rowValues.length).setValues([rowValues]);
      else              sh.appendRow(rowValues);

      // Historial SOLO en guardado explícito (decisión #5 de CLAUDE.md),
      // nunca en los syncs con debounce: evita engordar el archivo.
      if (mode === 'save') {
        try {
          var hist = _sheet(CONFIG.SHEET_HISTORIAL);
          if (hist.getLastRow() === 0) hist.appendRow(['ts','plan_id','correo','version','geom_json']);
          hist.appendRow([now, planId, correo, version, geomStr]);
        } catch (_) {}
      }
    } finally {
      try { lock.releaseLock(); } catch (_) {}
    }

    /* ---- 3) Correo: FUERA del lock (puede tardar 1-2 s, no bloquea a nadie) ---- */
    var emailed = false;                      // correo solo al guardar (1ra vez o si lo piden)
    if (mode === 'save' && (isNew || body.sendEmail)) {
      try {
        if (MailApp.getRemainingDailyQuota() > 0) {
          _sendPlanEmail(correo, nombre, planName, clave, planId);
          emailed = true;
        }
      } catch (_) { emailed = false; }        // sin cuota o fallo: el front avisa
    }

    return _json({ ok: true, plan_id: planId, version: version, isNew: isNew, emailed: emailed });

  } catch (err) {
    return _json({ ok: false, error: String(err) });
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

/* Busca por (correo, clave) leyendo SOLO las columnas correo y clave
   (nunca el blob geom_json: con miles de filas la diferencia es de MB a KB).
   Devuelve { rowIdx, obj, correoExiste, correoCount }:
     rowIdx       fila de la hoja (1-based) o -1
     obj          la fila completa como objeto (solo se lee ESA fila) o null
     correoExiste true si el correo aparece (para 'clave_incorrecta' vs 'no_existe')
     correoCount  proyectos de ese correo (para el tope anti-abuso) */
function _findByCredentials(correo, clave, shOpt) {
  correo = String(correo || '').toLowerCase(); clave = String(clave || '');
  var res = { rowIdx: -1, obj: null, correoExiste: false, correoCount: 0 };
  if (!correo || !clave) return res;
  var sh = shOpt || _sheet(CONFIG.SHEET_PLANOS);
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2) return res;
  var col = _colIndex(sh.getRange(1, 1, 1, lastCol).getValues()[0]);
  var correos = sh.getRange(2, col.correo + 1, lastRow - 1, 1).getValues();
  var claves  = sh.getRange(2, col.clave  + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < correos.length; i++) {
    if (String(correos[i][0]).toLowerCase() !== correo) continue;
    res.correoExiste = true; res.correoCount++;
    if (res.rowIdx < 0 && String(claves[i][0]) === clave) res.rowIdx = i + 2;
  }
  if (res.rowIdx > 0)
    res.obj = _rowObj(sh.getRange(res.rowIdx, 1, 1, lastCol).getValues()[0], col);
  return res;
}

/* Busca por plan_id leyendo SOLO la columna plan_id; trae la fila justa. */
function _findById(id) {
  id = String(id || ''); if (!id) return null;
  var sh = _sheet(CONFIG.SHEET_PLANOS);
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2) return null;
  var col = _colIndex(sh.getRange(1, 1, 1, lastCol).getValues()[0]);
  var ids = sh.getRange(2, col.plan_id + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++)
    if (String(ids[i][0]) === id)
      return _rowObj(sh.getRange(i + 2, 1, 1, lastCol).getValues()[0], col);
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
        '<p style="font-size:12px;color:#6b6256;font-weight:700;letter-spacing:1px">CroKiss &middot; Aurum Arquitectos</p>' +
      '</div>' +
    '</div>';
  MailApp.sendEmail({ to: correo, name: CONFIG.REMITENTE_NOMBRE,
    subject: 'Tu proyecto en CroKiss — tu clave para volver', htmlBody: html });
}

/* ====================== RESPALDO SEMANAL ======================
 * Copia el spreadsheet completo a la carpeta "CroKiss Respaldos" de Drive,
 * con la fecha en el nombre, y conserva solo las últimas 8 copias.
 *
 * CREAR EL TRIGGER (una sola vez, desde el editor de Apps Script):
 *   1. Menú izquierdo → Activadores (icono de reloj).
 *   2. "+ Añadir activador".
 *   3. Función: respaldoSemanal · Implementación: Principal (Head) ·
 *      Fuente del evento: Según tiempo · Tipo: Temporizador semanal ·
 *      Día y hora a gusto (p. ej. lunes, 4:00-5:00).
 *   4. Guardar y aceptar los permisos de Drive si los pide.
 */
function respaldoSemanal() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var NOMBRE_CARPETA = 'CroKiss Respaldos';
  var PREFIJO = 'CroKiss Respaldo ';
  var MAX_COPIAS = 8;

  var it = DriveApp.getFoldersByName(NOMBRE_CARPETA);
  var carpeta = it.hasNext() ? it.next() : DriveApp.createFolder(NOMBRE_CARPETA);

  var fecha = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  DriveApp.getFileById(ss.getId()).makeCopy(PREFIJO + fecha, carpeta);

  // Conservar solo las últimas MAX_COPIAS (las más antiguas a la papelera).
  var copias = [];
  var fs = carpeta.getFiles();
  while (fs.hasNext()) {
    var f = fs.next();
    if (f.getName().indexOf(PREFIJO) === 0) copias.push(f);
  }
  copias.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  for (var i = MAX_COPIAS; i < copias.length; i++) copias[i].setTrashed(true);
}

/* Corre esto UNA vez desde el editor de Apps Script para crear las
   pestañas y autorizar permisos (incluido el envío de correo). */
function setup() { _sheet(CONFIG.SHEET_PLANOS); _sheet(CONFIG.SHEET_HISTORIAL); }
