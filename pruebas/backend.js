/* =============================================================
   CroKiss — Pruebas de la lógica pura de Code.gs (node)

   Code.gs corre en Apps Script, que no existe fuera de Google. Aquí
   se carga el MISMO archivo con stubs mínimos de SpreadsheetApp,
   CacheService, MailApp y Utilities, y se ejercita la lógica que sí
   es pura: búsqueda por TextFinder, tope de 45k, rate-limit
   fail-closed, límites de campos, lecturas sin geom_json y poda.

   Correr:  node pruebas/backend.js
   (no necesita jsdom ni red)
   ============================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.resolve(__dirname, '..');

let pasadas = 0, fallidas = 0;
function ok(cond, nombre, detalle) {
  if (cond) { pasadas++; console.log('  ✓ ' + nombre); }
  else { fallidas++; console.log('  ✗ ' + nombre + (detalle ? '\n      → ' + detalle : '')); }
}
function grupo(n) { console.log('\n' + n); }

/* ================= stubs mínimos de Apps Script ================= */

const HEADERS = ['ts','plan_id','client_id','nombre','correo','clave',
                 'plan_name','version','marketing','source','geom_json'];

/* Hoja falsa que CUENTA qué se lee: así se demuestra que ninguna ruta
   arrastra la columna geom_json para buscar. */
function hojaFalsa(nombre, filas) {
  const celdas = [HEADERS.slice()].concat(filas.map((f) => f.slice()));
  return {
    nombre,
    celdas,
    lecturas: [],                       // [{fila, col, nFilas, nCols}]
    escrituras: [],
    getLastRow() { return this.celdas.length; },
    getLastColumn() { return HEADERS.length; },
    appendRow(v) { this.celdas.push(v.slice()); this.escrituras.push({ tipo: 'append', v }); },
    deleteRow(n) { this.celdas.splice(n - 1, 1); this.escrituras.push({ tipo: 'delete', n }); },
    getRange(fila, col, nFilas, nCols) {
      nFilas = nFilas || 1; nCols = nCols || 1;
      this.lecturas.push({ fila, col, nFilas, nCols });
      const sh = this;
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < nFilas; r++) {
            const src = sh.celdas[fila - 1 + r] || [];
            out.push(src.slice(col - 1, col - 1 + nCols));
          }
          return out;
        },
        getValue() { const src = sh.celdas[fila - 1] || []; return src[col - 1]; },
        setValues(v) { sh.celdas[fila - 1] = v[0].slice(); sh.escrituras.push({ tipo: 'set', fila, v: v[0] }); },
        // TextFinder acotado a ESTE rango (lo que hace _rowByPlanId)
        createTextFinder(texto) {
          let entero = false;
          const tf = {
            matchEntireCell(b) { entero = b; return tf; },
            findNext() {
              for (let r = 0; r < nFilas; r++) {
                const src = sh.celdas[fila - 1 + r] || [];
                for (let c = 0; c < nCols; c++) {
                  const v = String(src[col - 1 + c] == null ? '' : src[col - 1 + c]);
                  if (entero ? v === String(texto) : v.indexOf(String(texto)) >= 0) {
                    const filaAbs = fila + r;
                    return { getRow() { return filaAbs; } };
                  }
                }
              }
              return null;
            }
          };
          return tf;
        }
      };
    }
  };
}

function entorno(opciones) {
  opciones = opciones || {};
  const hojas = opciones.hojas || {};
  const cache = opciones.cache || new Map();
  const correosEnviados = [];
  const logs = { error: [], log: [] };

  const sandbox = {
    console: {
      error: (m) => logs.error.push(String(m)),
      log: (m) => logs.log.push(String(m))
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => hojas[n] || null,
        insertSheet: (n) => (hojas[n] = hojaFalsa(n, []))
      })
    },
    CacheService: {
      getScriptCache: () => {
        if (opciones.cacheRota) throw new Error('caché caída');
        return {
          get: (k) => (cache.has(k) ? cache.get(k) : null),
          put: (k, v) => cache.set(k, v)
        };
      }
    },
    MailApp: {
      getRemainingDailyQuota: () => (opciones.cuota == null ? 100 : opciones.cuota),
      sendEmail: (o) => correosEnviados.push(o)
    },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} })
    },
    Utilities: {
      getUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000',
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      computeDigest: (_alg, s) => require('crypto').createHash('md5').update(String(s)).digest(),
      DigestAlgorithm: { MD5: 'MD5' },
      Charset: { UTF_8: 'UTF-8' }
    },
    ContentService: {
      createTextOutput: (t) => ({ _t: t, setMimeType() { return this; } }),
      MimeType: { JSON: 'JSON' }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'Code.gs'), 'utf8'), sandbox, { filename: 'Code.gs' });
  return { sandbox, hojas, cache, correosEnviados, logs };
}

// desenvuelve la respuesta de _json()
const resp = (r) => JSON.parse(r._t);

/* filas de ejemplo — geom_json GRANDE a propósito, para probar que no se lee */
const BLOB = '{"walls":[' + '{"x1":0,"y1":0,"x2":1,"y2":0},'.repeat(400) + '{"x1":0,"y1":0,"x2":1,"y2":0}]}';
function filaPlan(id, correo, clave, nombrePlan, version) {
  return [new Date(), id, 'cli1', 'Ana', correo, clave, nombrePlan, version || 1, 'no', 'crokiss-web', BLOB];
}

/* =========================== PRUEBAS =========================== */

grupo('Lecturas quirúrgicas (el techo de escala de P1)');
{
  const planos = hojaFalsa('Planos', [
    filaPlan('ck1', 'ana@x.com', 'clave-uno'),
    filaPlan('ck2', 'ana@x.com', 'clave-uno'),
    filaPlan('ck3', 'beto@x.com', 'clave-dos')
  ]);
  const { sandbox } = entorno({ hojas: { Planos: planos } });

  const r = resp(sandbox.doGet({ parameter: { action: 'plan', id: 'ck2' } }));
  ok(r.ok === true, 'action=plan encuentra el plano por id');
  ok(r.plan_id === 'ck2', 'devuelve el plan_id correcto');
  ok(r.clave === undefined, 'action=plan NUNCA devuelve la clave');
  ok(r.correo === undefined, 'sin credenciales tampoco devuelve el correo');

  // ¿alguna lectura multi-fila incluyó la columna 11 (geom_json)?
  const gi = HEADERS.indexOf('geom_json') + 1;             // 11
  const barridos = planos.lecturas.filter((l) => l.nFilas > 1);
  const tocaronBlob = barridos.filter((l) => l.col + l.nCols - 1 >= gi);
  ok(tocaronBlob.length === 0,
     'ningún barrido de filas incluye la columna geom_json',
     JSON.stringify(tocaronBlob));

  const celdaBlob = planos.lecturas.filter((l) => l.nFilas === 1 && l.col === gi);
  ok(celdaBlob.length === 1, 'el blob se lee de UNA sola celda, y solo al abrir el plano',
     'lecturas de esa celda: ' + celdaBlob.length);

  // el TextFinder se usó sobre la columna de plan_id (col 2), no sobre la hoja
  const tfCol = HEADERS.indexOf('plan_id') + 1;
  ok(planos.lecturas.some((l) => l.col === tfCol && l.nCols === 1 && l.nFilas > 1),
     'la búsqueda por plan_id se acota a su propia columna');
}

{
  const planos = hojaFalsa('Planos', [filaPlan('ck1', 'ana@x.com', 'clave-uno')]);
  const { sandbox } = entorno({ hojas: { Planos: planos } });
  const r = resp(sandbox.doGet({ parameter: { correo: 'ana@x.com', clave: 'clave-uno' } }));
  ok(r.ok && r.count === 1, 'action=list encuentra por credenciales');
  ok(!('geom' in (r.items[0] || {})), 'list no devuelve geometría');
  const gi = HEADERS.indexOf('geom_json') + 1;
  ok(planos.lecturas.filter((l) => l.nFilas > 1 && l.col + l.nCols - 1 >= gi).length === 0,
     'list tampoco lee geom_json');
}

grupo('Búsqueda por TextFinder');
{
  const planos = hojaFalsa('Planos', [
    filaPlan('ck1', 'ana@x.com', 'k1'), filaPlan('ck22', 'ana@x.com', 'k1'), filaPlan('ck3', 'ana@x.com', 'k1')
  ]);
  const { sandbox } = entorno({ hojas: { Planos: planos } });
  ok(resp(sandbox.doGet({ parameter: { action: 'plan', id: 'ck22' } })).plan_id === 'ck22',
     'matchEntireCell distingue ck22 de ck2 (no hay coincidencia parcial)');
  ok(resp(sandbox.doGet({ parameter: { action: 'plan', id: 'ck9' } })).error === 'no_encontrado',
     'un id inexistente responde no_encontrado');
}

grupo('Tope de 45.000 (la bomba de tiempo de Sheets)');
{
  const planos = hojaFalsa('Planos', []);
  const { sandbox } = entorno({ hojas: { Planos: planos } });
  ok(sandbox.CONFIG.MAX_GEOM_BYTES === 45000, 'MAX_GEOM_BYTES = 45000 (era 200000)');

  const grande = { walls: [] };
  while (JSON.stringify(grande).length < 46000) grande.walls.push({ x1: 0, y1: 0, x2: 1, y2: 1, id: 'w' + grande.walls.length });
  const r = resp(sandbox.doPost({ postData: { contents: JSON.stringify({
    mode: 'save', correo: 'ana@x.com', clave: 'clave-uno', geom: grande }) } }));
  ok(r.error === 'plano_muy_grande', 'un plano de >45k se rechaza ANTES de escribir');
  ok(planos.escrituras.length === 0, 'y no dejó ninguna escritura a medias');
}

grupo('Límites de campos');
{
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) } });
  const post = (b) => resp(sandbox.doPost({ postData: { contents: JSON.stringify(b) } }));
  const geom = { walls: [{ x1: 0, y1: 0, x2: 1, y2: 0 }] };

  ok(post({ correo: 'a'.repeat(130) + '@x.com', clave: 'clave-uno', geom }).error === 'correo_invalido',
     'correo de más de 120 caracteres se rechaza');
  ok(post({ correo: 'ana@x.com', clave: 'x'.repeat(41), geom }).error === 'clave_invalida',
     'clave de más de 40 caracteres se rechaza');
  ok(post({ correo: 'ana@x.com', clave: 'abc', geom }).error === 'clave_corta',
     'cuenta NUEVA con clave de menos de 6 se rechaza');
}
{
  // compatibilidad sagrada: una cuenta VIEJA con clave corta sigue entrando
  const planos = hojaFalsa('Planos', [filaPlan('ck1', 'ana@x.com', 'abc', 'Mi proyecto')]);
  const { sandbox } = entorno({ hojas: { Planos: planos, Historial: hojaFalsa('Historial', []) } });
  const r = resp(sandbox.doPost({ postData: { contents: JSON.stringify({
    mode: 'save', correo: 'ana@x.com', clave: 'abc', plan_id: 'ck1',
    geom: { walls: [{ x1: 0, y1: 0, x2: 1, y2: 0 }] } }) } }));
  ok(r.ok === true, 'una cuenta EXISTENTE con clave corta sigue guardando (no se deja fuera al lead)');
  ok(r.isNew === false, 'y se reconoce como existente, no como nueva');
}

grupo('Rate-limit fail-closed y claves hasheadas');
{
  const { sandbox, cache } = entorno({ hojas: { Planos: hojaFalsa('Planos', [filaPlan('ck1', 'a@x.com', 'k')]) } });
  for (var i = 0; i < sandbox.CONFIG.MAX_PLAN_ID; i++) sandbox.doGet({ parameter: { action: 'plan', id: 'ck1' } });
  ok(resp(sandbox.doGet({ parameter: { action: 'plan', id: 'ck1' } })).error === 'demasiados_intentos',
     'action=plan corta al pasar el tope por hora');

  const claves = [...cache.keys()];
  ok(claves.length > 0 && claves.every((k) => k.length <= 250), 'toda clave de caché cabe en 250 chars');
  ok(claves.some((k) => k.indexOf('pl_') === 0), 'la clave de action=plan lleva su prefijo');
  ok(!claves.some((k) => k.indexOf('ck1') >= 0), 'el valor va hasheado, no en claro, dentro de la clave');
}
{
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) }, cacheRota: true });
  const r = resp(sandbox.doPost({ postData: { contents: JSON.stringify({
    mode: 'save', correo: 'ana@x.com', clave: 'clave-uno', geom: { walls: [{ x1: 0, y1: 0, x2: 1, y2: 0 }] } }) } }));
  ok(r.error === 'demasiados_intentos', '_rateOk es FAIL-CLOSED: si la caché cae, se rechaza');
}
{
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) } });
  ok(sandbox._rateOk('x', 0, 60) === false, '_rateOk respeta max=0');
}

grupo('Guardado por correo con tope');
{
  const { sandbox, cache } = entorno({ hojas: { Planos: hojaFalsa('Planos', []), Historial: hojaFalsa('Historial', []) } });
  const geom = { walls: [{ x1: 0, y1: 0, x2: 1, y2: 0 }] };
  let ultimo;
  for (var i = 0; i <= sandbox.CONFIG.MAX_SAVE_CORREO; i++)
    ultimo = resp(sandbox.doPost({ postData: { contents: JSON.stringify({
      mode: 'save', correo: 'ana@x.com', clave: 'clave-uno', plan_name: 'P' + i, geom }) } }));
  ok(ultimo.error === 'demasiados_intentos', 'doPost corta al pasar el tope de guardados por hora');
}

grupo('Errores opacos');
{
  const planos = hojaFalsa('Planos', []);
  planos.getRange = () => { throw new Error('detalle secreto de la hoja'); };
  const { sandbox, logs } = entorno({ hojas: { Planos: planos } });
  const r = resp(sandbox.doGet({ parameter: { action: 'plan', id: 'ck1' } }));
  ok(r.error === 'error_interno', 'el cliente recibe error_interno, no el stack');
  ok(logs.error.some((m) => m.indexOf('detalle secreto') >= 0), 'el detalle real sí queda en console.error');
}

grupo('El correo sale FUERA del lock');
{
  const planos = hojaFalsa('Planos', []);
  const { sandbox, correosEnviados } = entorno({ hojas: { Planos: planos, Historial: hojaFalsa('Historial', []) } });
  let lockAbierto = false, correoConLock = null;
  sandbox.LockService = { getScriptLock: () => ({
    waitLock() { lockAbierto = true; }, releaseLock() { lockAbierto = false; } }) };
  const mailOriginal = sandbox.MailApp.sendEmail;
  sandbox.MailApp.sendEmail = (o) => { correoConLock = lockAbierto; return mailOriginal(o); };

  const r = resp(sandbox.doPost({ postData: { contents: JSON.stringify({
    mode: 'save', correo: 'ana@x.com', clave: 'clave-uno',
    geom: { walls: [{ x1: 0, y1: 0, x2: 1, y2: 0 }] } }) } }));
  ok(r.ok && r.emailed === true, 'un guardado nuevo manda el correo');
  ok(correoConLock === false, 'el lock YA estaba liberado cuando se mandó el correo');
  ok(correosEnviados.length === 1, 'se mandó exactamente un correo');
}

grupo('_canEmail: fail-closed y cuota');
{
  const { sandbox } = entorno({ cuota: 2 });
  ok(sandbox._canEmail('a@x.com') === false, 'con la cuota de MailApp casi agotada, no manda');
}
{
  const { sandbox } = entorno({ cacheRota: true });
  ok(sandbox._canEmail('a@x.com') === false, '_canEmail es FAIL-CLOSED si la caché cae');
}

grupo('Poda del Historial');
{
  const filas = [];
  const hoy = Date.now();
  // 25 versiones recientes del plano A (deben quedar 20)
  for (let i = 0; i < 25; i++) filas.push([new Date(hoy - i * 60000), 'A', 'Plan A', 'a@x.com', 25 - i, BLOB]);
  // 3 versiones viejísimas del plano B (deben irse todas por antigüedad)
  for (let i = 0; i < 3; i++) filas.push([new Date(hoy - 120 * 24 * 3600 * 1000), 'B', 'Plan B', 'b@x.com', i, BLOB]);
  const hist = hojaFalsa('Historial', filas);
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []), Historial: hist } });

  const borradas = sandbox.podarHistorial();
  ok(borradas === 8, 'podó 5 versiones sobrantes de A + 3 viejas de B', 'borradas: ' + borradas);
  const quedan = hist.celdas.slice(1);
  ok(quedan.filter((f) => f[1] === 'A').length === 20, 'quedan exactamente 20 versiones de A');
  ok(quedan.filter((f) => f[1] === 'B').length === 0, 'no queda nada de más de 90 días');
  const gi = 6;
  ok(hist.lecturas.every((l) => l.col + l.nCols - 1 < gi), 'podar no leyó la columna geom_json');
}

grupo('healthPing');
{
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) } });
  ok(sandbox.healthPing() === true, 'con la hoja sana devuelve true');
}
{
  const planos = hojaFalsa('Planos', []);
  planos.getRange = () => { throw new Error('hoja caída'); };
  const { sandbox, correosEnviados } = entorno({ hojas: { Planos: planos } });
  ok(sandbox.healthPing() === false, 'con la hoja caída devuelve false');
  ok(correosEnviados.length === 1 && /no responde/.test(correosEnviados[0].subject),
     'y manda la alerta por correo');
  sandbox.healthPing();
  ok(correosEnviados.length === 1, 'no inunda el buzón: solo 1 aviso por ventana');
}

grupo('Honeypot y validaciones básicas');
{
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) } });
  const post = (b) => resp(sandbox.doPost({ postData: { contents: JSON.stringify(b) } }));
  ok(post({ website: 'bot', correo: 'a@x.com', clave: 'clave-uno' }).error === 'spam', 'el honeypot corta bots');
  ok(post({ correo: 'no-es-correo', clave: 'clave-uno' }).error === 'correo_invalido', 'correo inválido se rechaza');
  ok(post({ correo: 'a@x.com', clave: 'clave-uno', geom: { nada: 1 } }).error === 'plano_invalido', 'geom sin muros se rechaza');
  ok(resp(sandbox.doGet({ parameter: { action: 'ping' } })).pong === true, 'ping responde');
}

grupo('sync no crea proyectos');
{
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) } });
  const r = resp(sandbox.doPost({ postData: { contents: JSON.stringify({
    mode: 'sync', correo: 'ana@x.com', clave: 'clave-uno', geom: { walls: [{ x1: 0, y1: 0, x2: 1, y2: 0 }] } }) } }));
  ok(r.error === 'no_existe', 'mode:sync sobre algo inexistente responde no_existe');
}

console.log('\n' + '─'.repeat(52));
console.log(pasadas + ' pasadas · ' + fallidas + ' fallidas');
process.exit(fallidas ? 1 : 0);
