/* =============================================================
   CroKiss — Pruebas de la lógica pura de Code.gs (node)

   Code.gs corre en Apps Script, que no existe fuera de Google. Aquí
   se carga el MISMO archivo con stubs mínimos de SpreadsheetApp,
   CacheService, MailApp/GmailApp, PropertiesService y Utilities, y se
   ejercita la lógica que sí es pura.

   Lo que más importa aquí es la MATRIZ DE MIGRACIÓN de la clave: una
   cuenta que ya existe NO se puede quedar fuera. Se prueba con hoja
   de esquema viejo (sin clave_hash) y de esquema nuevo.

   Correr:  node pruebas/backend.js     (no necesita jsdom ni red)
   ============================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const RAIZ = path.resolve(__dirname, '..');

let pasadas = 0, fallidas = 0;
function ok(cond, nombre, detalle) {
  if (cond) { pasadas++; console.log('  ✓ ' + nombre); }
  else { fallidas++; console.log('  ✗ ' + nombre + (detalle ? '\n      → ' + detalle : '')); }
}
function grupo(n) { console.log('\n' + n); }

/* ================= esquemas ================= */
// Esquema anterior a P2: la clave vive en claro y no hay columna de hash.
const H_VIEJO = ['ts','plan_id','client_id','nombre','correo','clave',
                 'plan_name','version','marketing','source','geom_json'];
// Esquema de P2: clave_hash antes de geom_json (el blob siempre al final).
const H_NUEVO = ['ts','plan_id','client_id','nombre','correo','clave',
                 'plan_name','version','marketing','source','clave_hash','geom_json'];

/* ================= stubs mínimos de Apps Script ================= */

/* Hoja falsa que CUENTA qué se lee: así se demuestra que ninguna ruta
   arrastra la columna geom_json para buscar. */
function hojaFalsa(nombre, filas, headers) {
  // headers === null crea una hoja REALMENTE vacía (como insertSheet en Sheets)
  const H = headers === null ? null : (headers || H_NUEVO);
  const celdas = (H ? [H.slice()] : []).concat(filas.map((f) => f.slice()));
  return {
    nombre,
    celdas,
    lecturas: [],                       // [{fila, col, nFilas, nCols}]
    escrituras: [],
    headers() { return this.celdas[0] || []; },
    colDe(nombreCol) { return (this.celdas[0] || []).indexOf(nombreCol) + 1; },   // 1-based
    getLastRow() { return this.celdas.length; },
    getLastColumn() { return this.celdas.length ? this.celdas[0].length : 0; },
    appendRow(v) { this.celdas.push(v.slice()); this.escrituras.push({ tipo: 'append', v }); },
    deleteRow(n) { this.celdas.splice(n - 1, 1); this.escrituras.push({ tipo: 'delete', n }); },
    insertColumnBefore(n) {
      this.celdas.forEach((f) => f.splice(n - 1, 0, ''));
      this.escrituras.push({ tipo: 'insertCol', n });
    },
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
        setValue(v) {
          if (!sh.celdas[fila - 1]) sh.celdas[fila - 1] = [];
          sh.celdas[fila - 1][col - 1] = v;
          sh.escrituras.push({ tipo: 'setValue', fila, col, v });
        },
        setValues(v) {
          // la API real escribe TODO el rango, no solo la primera fila
          v.forEach((f, i) => { sh.celdas[fila - 1 + i] = f.slice(); });
          sh.escrituras.push({ tipo: 'set', fila, filas: v.length });
        },
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

const SALT_FIJO = 'salt-de-prueba-0000';

function entorno(opciones) {
  opciones = opciones || {};
  const hojas = opciones.hojas || {};
  const cache = opciones.cache || new Map();
  const props = new Map(opciones.props || [['CK_SALT', SALT_FIJO]]);
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
        insertSheet: (n) => (hojas[n] = hojaFalsa(n, [], null))
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
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, v)
      })
    },
    MailApp: {
      getRemainingDailyQuota: () => (opciones.cuota == null ? 100 : opciones.cuota),
      sendEmail: (o) => correosEnviados.push(Object.assign({ via: 'MailApp' }, o))
    },
    // Por defecto el alias NO existe (como en una cuenta Gmail normal): así se
    // prueba que el correo igual sale por MailApp.
    GmailApp: {
      sendEmail: (to, subject, body, o) => {
        if (!opciones.aliasOk) throw new Error('alias no configurado');
        correosEnviados.push(Object.assign({ via: 'GmailApp', to, subject }, o));
      }
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => 'aaaaaaaa-bbbb-cccc-dddd-' + String(Math.random()).slice(2, 14),
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      computeDigest: (alg, s) =>
        crypto.createHash(alg === 'SHA_256' ? 'sha256' : 'md5').update(String(s)).digest(),
      DigestAlgorithm: { MD5: 'MD5', SHA_256: 'SHA_256' },
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
  return { sandbox, hojas, cache, props, correosEnviados, logs };
}

// desenvuelve la respuesta de _json()
const resp = (r) => JSON.parse(r._t);
const post = (sandbox, b) => resp(sandbox.doPost({ postData: { contents: JSON.stringify(b) } }));

// hash esperado, calculado igual que Code.gs
function hashDe(correo, clave) {
  return crypto.createHash('sha256')
    .update(String(correo).toLowerCase() + '|' + clave + '|' + SALT_FIJO).digest('base64');
}

/* geom_json GRANDE a propósito, para probar que no se lee */
const BLOB = '{"walls":[' + '{"x1":0,"y1":0,"x2":1,"y2":0},'.repeat(400) + '{"x1":0,"y1":0,"x2":1,"y2":0}]}';

/* Un plano "real" (pasa el filtro de contenido para el correo) */
const GEOM_REAL = {
  walls: [{ x1: 0, y1: 0, x2: 8, y2: 0 }, { x1: 8, y1: 0, x2: 8, y2: 9 },
          { x1: 0, y1: 9, x2: 8, y2: 9 }, { x1: 0, y1: 0, x2: 0, y2: 9 }],
  windows: [{ id: 'v1', wall: 'h', fixed: 0, a: 1, b: 2 }],
  doors: [{ id: 'd1', wall: 'h', hx: 3, hy: 0, w: 0.9 }],
  sliders: [], furniture: []
};
/* Solo el terreno: 4 muros y nada más (NO debe disparar correo) */
const GEOM_VACIO = { walls: GEOM_REAL.walls, windows: [], doors: [], sliders: [], furniture: [] };

/* filas de ejemplo */
function filaVieja(id, correo, clave, nombrePlan) {   // esquema H_VIEJO, clave en claro
  return [new Date(), id, 'cli1', 'Ana', correo, clave, nombrePlan || 'Mi proyecto', 1, 'no', 'crokiss-web', BLOB];
}
function filaMigrada(id, correo, clave, nombrePlan) { // esquema H_NUEVO, clave vacía + hash
  return [new Date(), id, 'cli1', 'Ana', correo, '', nombrePlan || 'Mi proyecto', 1, 'no', 'crokiss-web',
          hashDe(correo, clave), BLOB];
}

/* =========================== PRUEBAS =========================== */

grupo('Lecturas quirúrgicas (el techo de escala de P1)');
{
  const planos = hojaFalsa('Planos', [
    filaMigrada('ck1', 'ana@x.com', 'clave-uno'),
    filaMigrada('ck2', 'ana@x.com', 'clave-uno'),
    filaMigrada('ck3', 'beto@x.com', 'clave-dos')
  ]);
  const { sandbox } = entorno({ hojas: { Planos: planos } });

  const r = resp(sandbox.doGet({ parameter: { action: 'plan', id: 'ck2' } }));
  ok(r.ok === true, 'action=plan encuentra el plano por id');
  ok(r.plan_id === 'ck2', 'devuelve el plan_id correcto');
  ok(r.clave === undefined, 'action=plan NUNCA devuelve la clave');
  ok(r.correo === undefined, 'sin credenciales tampoco devuelve el correo');

  const gi = planos.colDe('geom_json');
  const barridos = planos.lecturas.filter((l) => l.nFilas > 1);
  const tocaronBlob = barridos.filter((l) => l.col + l.nCols - 1 >= gi);
  ok(tocaronBlob.length === 0, 'ningún barrido de filas incluye la columna geom_json',
     JSON.stringify(tocaronBlob));

  const celdaBlob = planos.lecturas.filter((l) => l.nFilas === 1 && l.col === gi);
  ok(celdaBlob.length === 1, 'el blob se lee de UNA sola celda, y solo al abrir el plano');

  const tfCol = planos.colDe('plan_id');
  ok(planos.lecturas.some((l) => l.col === tfCol && l.nCols === 1 && l.nFilas > 1),
     'la búsqueda por plan_id se acota a su propia columna');
}
{
  const planos = hojaFalsa('Planos', [filaMigrada('ck1', 'ana@x.com', 'clave-uno')]);
  const { sandbox } = entorno({ hojas: { Planos: planos } });
  const r = resp(sandbox.doGet({ parameter: { correo: 'ana@x.com', clave: 'clave-uno' } }));
  ok(r.ok && r.count === 1, 'action=list encuentra por credenciales');
  ok(!('geom' in (r.items[0] || {})), 'list no devuelve geometría');
  const gi = planos.colDe('geom_json');
  ok(planos.lecturas.filter((l) => l.nFilas > 1 && l.col + l.nCols - 1 >= gi).length === 0,
     'list tampoco lee geom_json');
}

grupo('Búsqueda por TextFinder');
{
  const planos = hojaFalsa('Planos', [
    filaMigrada('ck1', 'a@x.com', 'k1'), filaMigrada('ck22', 'a@x.com', 'k1'), filaMigrada('ck3', 'a@x.com', 'k1')
  ]);
  const { sandbox } = entorno({ hojas: { Planos: planos } });
  ok(resp(sandbox.doGet({ parameter: { action: 'plan', id: 'ck22' } })).plan_id === 'ck22',
     'matchEntireCell distingue ck22 de ck2 (no hay coincidencia parcial)');
  ok(resp(sandbox.doGet({ parameter: { action: 'plan', id: 'ck9' } })).error === 'no_encontrado',
     'un id inexistente responde no_encontrado');
}

/* ============ LA MATRIZ DE MIGRACIÓN (lo más importante de P2) ============ */

grupo('Migración de clave · cuenta VIEJA (texto plano)');
{
  const planos = hojaFalsa('Planos', [filaVieja('ck1', 'ana@x.com', 'clave-uno')], H_VIEJO);
  const { sandbox } = entorno({ hojas: { Planos: planos } });

  const r = resp(sandbox.doGet({ parameter: { action: 'plan', id: 'ck1', correo: 'ana@x.com', clave: 'clave-uno' } }));
  ok(r.ok === true, 'una cuenta vieja abre su plano con su clave de siempre');
  ok(r.correo === 'ana@x.com', 'al autenticarse sí recibe su propio correo');
}
{
  // la hoja vieja no tiene columna de hash: al guardar se crea sola
  const planos = hojaFalsa('Planos', [filaVieja('ck1', 'ana@x.com', 'clave-uno')], H_VIEJO);
  const { sandbox } = entorno({ hojas: { Planos: planos, Historial: hojaFalsa('Historial', [], ['ts','plan_id','plan_name','correo','version','geom_json']) } });
  const r = post(sandbox, { mode: 'save', plan_id: 'ck1', correo: 'ana@x.com', clave: 'clave-uno', geom: GEOM_REAL });
  ok(r.ok === true, 'y puede GUARDAR con su clave de siempre');
  ok(planos.headers().indexOf('clave_hash') >= 0, 'la columna clave_hash se crea sola');
  ok(planos.headers().indexOf('clave_hash') < planos.headers().indexOf('geom_json'),
     'y queda ANTES de geom_json (el blob sigue siendo la última columna)');

  const fila = planos.celdas[1];
  const cH = planos.colDe('clave_hash') - 1, cC = planos.colDe('clave') - 1;
  ok(String(fila[cH]) === hashDe('ana@x.com', 'clave-uno'), 'la fila quedó con el hash correcto');
  ok(String(fila[cC]) === '', 'y la celda de clave en claro quedó VACÍA');
}
{
  // migración al solo ABRIR (sin guardar), sobre hoja que ya tiene la columna
  const planos = hojaFalsa('Planos', [
    [new Date(), 'ck1', 'c', 'Ana', 'ana@x.com', 'clave-uno', 'Mi proyecto', 1, 'no', 'crokiss-web', '', BLOB]
  ], H_NUEVO);
  const { sandbox } = entorno({ hojas: { Planos: planos } });
  const r = resp(sandbox.doGet({ parameter: { action: 'plan', id: 'ck1', correo: 'ana@x.com', clave: 'clave-uno' } }));
  ok(r.ok === true, 'abrir con clave correcta funciona sobre fila sin migrar');
  const fila = planos.celdas[1];
  ok(String(fila[planos.colDe('clave_hash') - 1]) === hashDe('ana@x.com', 'clave-uno'),
     'ABRIR migra la fila en ese momento');
  ok(String(fila[planos.colDe('clave') - 1]) === '', 'y borra la clave en claro');

  // y después de migrada sigue entrando
  const r2 = resp(sandbox.doGet({ parameter: { action: 'plan', id: 'ck1', correo: 'ana@x.com', clave: 'clave-uno' } }));
  ok(r2.ok === true, 'tras migrar, la misma clave sigue funcionando');
}

grupo('Migración de clave · cuenta YA MIGRADA');
{
  const planos = hojaFalsa('Planos', [filaMigrada('ck1', 'ana@x.com', 'clave-uno')]);
  const { sandbox } = entorno({ hojas: { Planos: planos, Historial: hojaFalsa('Historial', [], ['ts','plan_id','plan_name','correo','version','geom_json']) } });
  ok(resp(sandbox.doGet({ parameter: { action: 'plan', id: 'ck1', correo: 'ana@x.com', clave: 'clave-uno' } })).ok === true,
     'una cuenta migrada abre su plano');
  ok(post(sandbox, { mode: 'save', plan_id: 'ck1', correo: 'ana@x.com', clave: 'clave-uno', geom: GEOM_REAL }).ok === true,
     'y guarda normalmente');
  ok(resp(sandbox.doGet({ parameter: { correo: 'ana@x.com', clave: 'clave-uno' } })).count === 1,
     'y aparece en "Abrir con clave" (list)');
}

grupo('Migración de clave · clave INCORRECTA en los dos esquemas');
{
  const vieja = hojaFalsa('Planos', [filaVieja('ck1', 'ana@x.com', 'clave-uno')], H_VIEJO);
  const e1 = entorno({ hojas: { Planos: vieja } });
  ok(resp(e1.sandbox.doGet({ parameter: { action: 'plan', id: 'ck1', correo: 'ana@x.com', clave: 'mala' } })).error === 'no_autorizado',
     'cuenta vieja: clave incorrecta se rechaza');
  ok(String(vieja.celdas[1][5]) === 'clave-uno', 'y una clave incorrecta NO migra la fila');

  const nueva = hojaFalsa('Planos', [filaMigrada('ck1', 'ana@x.com', 'clave-uno')]);
  const e2 = entorno({ hojas: { Planos: nueva } });
  ok(resp(e2.sandbox.doGet({ parameter: { action: 'plan', id: 'ck1', correo: 'ana@x.com', clave: 'mala' } })).error === 'no_autorizado',
     'cuenta migrada: clave incorrecta se rechaza');
  ok(resp(e2.sandbox.doGet({ parameter: { correo: 'ana@x.com', clave: 'mala' } })).count === 0,
     'y list no la encuentra con clave incorrecta');
  ok(post(e2.sandbox, { mode: 'save', plan_id: 'ck1', correo: 'ana@x.com', clave: 'mala', geom: GEOM_REAL }).error === 'no_autorizado',
     'y no puede guardar encima con clave incorrecta');
}

grupo('Migración de clave · proyecto NUEVO nace hasheado');
{
  const planos = hojaFalsa('Planos', []);
  const { sandbox } = entorno({ hojas: { Planos: planos, Historial: hojaFalsa('Historial', [], ['ts','plan_id','plan_name','correo','version','geom_json']) } });
  const r = post(sandbox, { mode: 'save', correo: 'nuevo@x.com', clave: 'clave-nueva', geom: GEOM_REAL });
  ok(r.ok && r.isNew, 'se crea el proyecto');
  const fila = planos.celdas[1];
  ok(String(fila[planos.colDe('clave_hash') - 1]) === hashDe('nuevo@x.com', 'clave-nueva'), 'nace con hash');
  ok(String(fila[planos.colDe('clave') - 1]) === '', 'y JAMÁS escribe la clave en claro');
}
{
  // el SALT se crea solo si falta, y no cambia entre llamadas
  const { sandbox, props } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) }, props: [] });
  const h1 = sandbox._hashClave('a@x.com', 'clave-uno');
  const salt = props.get('CK_SALT');
  ok(!!salt, 'el SALT se crea solo la primera vez');
  ok(sandbox._hashClave('a@x.com', 'clave-uno') === h1, 'y es estable entre llamadas');
  ok(sandbox._hashClave('b@x.com', 'clave-uno') !== h1, 'el correo entra al hash (dos cuentas, dos hashes)');
}

grupo('Credenciales por POST (fuera de la barra de direcciones)');
{
  const planos = hojaFalsa('Planos', [filaMigrada('ck1', 'ana@x.com', 'clave-uno')]);
  const { sandbox } = entorno({ hojas: { Planos: planos } });
  const rl = post(sandbox, { mode: 'abrir', correo: 'ana@x.com', clave: 'clave-uno' });
  ok(rl.ok && rl.count === 1, 'mode:abrir lista los proyectos por POST');
  const rp = post(sandbox, { mode: 'plan', id: 'ck1', correo: 'ana@x.com', clave: 'clave-uno' });
  ok(rp.ok && rp.plan_id === 'ck1', 'mode:plan abre el proyecto por POST');
  ok(rp.clave === undefined, 'y tampoco devuelve la clave');
  ok(post(sandbox, { mode: 'plan', id: 'ck1', correo: 'ana@x.com', clave: 'mala' }).error === 'no_autorizado',
     'mode:plan valida la clave');
}

grupo('Correo: solo a planos reales y con clave inofensiva');
{
  const mk = () => entorno({ hojas: { Planos: hojaFalsa('Planos', []), Historial: hojaFalsa('Historial', [], ['ts','plan_id','plan_name','correo','version','geom_json']) } });

  let e = mk();
  ok(post(e.sandbox, { mode: 'save', correo: 'a@x.com', clave: 'clave-uno', geom: GEOM_REAL }).emailed === true,
     'plano real + clave normal → sí manda correo');

  e = mk();
  const r2 = post(e.sandbox, { mode: 'save', correo: 'a@x.com', clave: 'clave-uno', geom: GEOM_VACIO });
  ok(r2.ok === true, 'un plano vacío SÍ se guarda');
  ok(r2.emailed === false, 'pero NO dispara correo (así se bombardeaba un buzón ajeno)');
  ok(e.correosEnviados.length === 0, 'y de verdad no salió ningún correo');

  e = mk();
  const r3 = post(e.sandbox, { mode: 'save', correo: 'a@x.com', clave: 'Da clic aquí <b>ya</b>!!', geom: GEOM_REAL });
  ok(r3.ok === true, 'una clave con formato raro no impide guardar');
  ok(r3.emailed === false, 'pero no se manda correo con texto arbitrario en el lugar de la clave');

  ok(mk().sandbox._claveEnviable('mi-casa_2026') === true, 'clave normal pasa el formato');
  ok(mk().sandbox._claveEnviable('abc') === false, 'clave de menos de 6 no pasa');
  ok(mk().sandbox._claveEnviable('<script>alert(1)</script>') === false, 'clave con HTML no pasa');
}
{
  const { sandbox } = entorno({});
  const sucio = sandbox._nombreLimpio('Ana <b>María</b> 123');
  ok(!/[<>0-9]/.test(sucio), 'el nombre pierde marcas de HTML y dígitos antes de la plantilla', sucio);
  ok(/María/.test(sucio), 'pero conserva los acentos de un nombre real', sucio);
  ok(sandbox._nombreLimpio('x'.repeat(80)).length === 40, 'y se recorta a 40 caracteres');
}
{
  // la rama sendEmail ya no existe: no se puede forzar un reenvío a un tercero
  const planos = hojaFalsa('Planos', [filaMigrada('ck1', 'victima@x.com', 'clave-uno')]);
  const e = entorno({ hojas: { Planos: planos, Historial: hojaFalsa('Historial', [], ['ts','plan_id','plan_name','correo','version','geom_json']) } });
  const r = post(e.sandbox, { mode: 'save', plan_id: 'ck1', correo: 'victima@x.com', clave: 'clave-uno',
                              sendEmail: true, geom: GEOM_REAL });
  ok(r.ok === true && r.emailed === false, 'sendEmail:true ya NO fuerza un correo a un proyecto existente');
  ok(e.correosEnviados.length === 0, 'no salió correo');
}
{
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) } });
  ok(sandbox.CONFIG.MAX_EMAIL_DIA === 40 && sandbox.CONFIG.MAX_EMAIL_CORREO === 2,
     'topes de correo bajados a 40/día y 2 por destinatario');
}
{
  // alias del dominio disponible → sale por GmailApp; si no, cae a MailApp
  const e = entorno({ aliasOk: true, hojas: { Planos: hojaFalsa('Planos', []), Historial: hojaFalsa('Historial', [], ['ts','plan_id','plan_name','correo','version','geom_json']) } });
  post(e.sandbox, { mode: 'save', correo: 'a@x.com', clave: 'clave-uno', geom: GEOM_REAL });
  ok(e.correosEnviados[0] && e.correosEnviados[0].via === 'GmailApp', 'con alias, sale por GmailApp');
  ok(e.correosEnviados[0].from === 'direccion@aurumarquitectos.com', 'y desde el dominio de Aurum');

  const e2 = entorno({ aliasOk: false, hojas: { Planos: hojaFalsa('Planos', []), Historial: hojaFalsa('Historial', [], ['ts','plan_id','plan_name','correo','version','geom_json']) } });
  post(e2.sandbox, { mode: 'save', correo: 'a@x.com', clave: 'clave-uno', geom: GEOM_REAL });
  ok(e2.correosEnviados[0] && e2.correosEnviados[0].via === 'MailApp', 'sin alias, cae a MailApp y el correo igual sale');
}

grupo('Tope de 45.000 (la bomba de tiempo de Sheets)');
{
  const planos = hojaFalsa('Planos', []);
  const { sandbox } = entorno({ hojas: { Planos: planos } });
  ok(sandbox.CONFIG.MAX_GEOM_BYTES === 45000, 'MAX_GEOM_BYTES = 45000 (era 200000)');

  const grande = { walls: [] };
  while (JSON.stringify(grande).length < 46000) grande.walls.push({ x1: 0, y1: 0, x2: 1, y2: 1, id: 'w' + grande.walls.length });
  ok(post(sandbox, { mode: 'save', correo: 'ana@x.com', clave: 'clave-uno', geom: grande }).error === 'plano_muy_grande',
     'un plano de >45k se rechaza ANTES de escribir');
  ok(planos.escrituras.length === 0, 'y no dejó ninguna escritura a medias');
}

grupo('Límites de campos');
{
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) } });
  ok(post(sandbox, { correo: 'a'.repeat(130) + '@x.com', clave: 'clave-uno', geom: GEOM_REAL }).error === 'correo_invalido',
     'correo de más de 120 caracteres se rechaza');
  ok(post(sandbox, { correo: 'ana@x.com', clave: 'x'.repeat(41), geom: GEOM_REAL }).error === 'clave_invalida',
     'clave de más de 40 caracteres se rechaza');
  ok(post(sandbox, { correo: 'ana@x.com', clave: 'abc', geom: GEOM_REAL }).error === 'clave_corta',
     'cuenta NUEVA con clave de menos de 6 se rechaza');
}
{
  // compatibilidad sagrada: una cuenta VIEJA con clave corta sigue entrando
  const planos = hojaFalsa('Planos', [filaVieja('ck1', 'ana@x.com', 'abc')], H_VIEJO);
  const { sandbox } = entorno({ hojas: { Planos: planos, Historial: hojaFalsa('Historial', [], ['ts','plan_id','plan_name','correo','version','geom_json']) } });
  const r = post(sandbox, { mode: 'save', correo: 'ana@x.com', clave: 'abc', plan_id: 'ck1', geom: GEOM_REAL });
  ok(r.ok === true, 'una cuenta EXISTENTE con clave corta sigue guardando (no se deja fuera al lead)');
  ok(r.isNew === false, 'y se reconoce como existente, no como nueva');
}

grupo('Rate-limit fail-closed y claves hasheadas');
{
  const { sandbox, cache } = entorno({ hojas: { Planos: hojaFalsa('Planos', [filaMigrada('ck1', 'a@x.com', 'k')]) } });
  for (let i = 0; i < sandbox.CONFIG.MAX_PLAN_ID; i++) sandbox.doGet({ parameter: { action: 'plan', id: 'ck1' } });
  ok(resp(sandbox.doGet({ parameter: { action: 'plan', id: 'ck1' } })).error === 'demasiados_intentos',
     'action=plan corta al pasar el tope por hora');

  const claves = [...cache.keys()];
  ok(claves.length > 0 && claves.every((k) => k.length <= 250), 'toda clave de caché cabe en 250 chars');
  ok(claves.some((k) => k.indexOf('pl_') === 0), 'la clave de action=plan lleva su prefijo');
  ok(!claves.some((k) => k.indexOf('ck1') >= 0), 'el valor va hasheado, no en claro, dentro de la clave');
}
{
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) }, cacheRota: true });
  ok(post(sandbox, { mode: 'save', correo: 'ana@x.com', clave: 'clave-uno', geom: GEOM_REAL }).error === 'demasiados_intentos',
     '_rateOk es FAIL-CLOSED: si la caché cae, se rechaza');
}
{
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) } });
  ok(sandbox._rateOk('x', 0, 60) === false, '_rateOk respeta max=0');
}

grupo('Guardado por correo con tope');
{
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []), Historial: hojaFalsa('Historial', [], ['ts','plan_id','plan_name','correo','version','geom_json']) } });
  let ultimo;
  for (let i = 0; i <= sandbox.CONFIG.MAX_SAVE_CORREO; i++)
    ultimo = post(sandbox, { mode: 'save', correo: 'ana@x.com', clave: 'clave-uno', plan_name: 'P' + i, geom: GEOM_REAL });
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
  const { sandbox, correosEnviados } = entorno({ hojas: { Planos: planos, Historial: hojaFalsa('Historial', [], ['ts','plan_id','plan_name','correo','version','geom_json']) } });
  let lockAbierto = false, correoConLock = null;
  sandbox.LockService = { getScriptLock: () => ({
    waitLock() { lockAbierto = true; }, releaseLock() { lockAbierto = false; } }) };
  const mailOriginal = sandbox.MailApp.sendEmail;
  sandbox.MailApp.sendEmail = (o) => { correoConLock = lockAbierto; return mailOriginal(o); };

  const r = post(sandbox, { mode: 'save', correo: 'ana@x.com', clave: 'clave-uno', geom: GEOM_REAL });
  ok(r.ok && r.emailed === true, 'un guardado nuevo manda el correo');
  ok(correoConLock === false, 'el lock YA estaba liberado cuando se mandó el correo');
  ok(correosEnviados.length === 1, 'se mandó exactamente un correo');
}

grupo('_canEmail: fail-closed y cuota');
{
  ok(entorno({ cuota: 2 }).sandbox._canEmail('a@x.com') === false, 'con la cuota de MailApp casi agotada, no manda');
  ok(entorno({ cacheRota: true }).sandbox._canEmail('a@x.com') === false, '_canEmail es FAIL-CLOSED si la caché cae');
}

grupo('Poda del Historial');
{
  const H_HIST = ['ts','plan_id','plan_name','correo','version','geom_json'];
  const filas = [];
  const hoy = Date.now();
  for (let i = 0; i < 25; i++) filas.push([new Date(hoy - i * 60000), 'A', 'Plan A', 'a@x.com', 25 - i, BLOB]);
  for (let i = 0; i < 3; i++) filas.push([new Date(hoy - 120 * 24 * 3600 * 1000), 'B', 'Plan B', 'b@x.com', i, BLOB]);
  const hist = hojaFalsa('Historial', filas, H_HIST);
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []), Historial: hist } });

  const borradas = sandbox.podarHistorial();
  ok(borradas === 8, 'podó 5 versiones sobrantes de A + 3 viejas de B', 'borradas: ' + borradas);
  const quedan = hist.celdas.slice(1);
  ok(quedan.filter((f) => f[1] === 'A').length === 20, 'quedan exactamente 20 versiones de A');
  ok(quedan.filter((f) => f[1] === 'B').length === 0, 'no queda nada de más de 90 días');
  ok(hist.lecturas.every((l) => l.col + l.nCols - 1 < 6), 'podar no leyó la columna geom_json');
}

grupo('healthPing');
{
  ok(entorno({ hojas: { Planos: hojaFalsa('Planos', []) } }).sandbox.healthPing() === true,
     'con la hoja sana devuelve true');
  const planos = hojaFalsa('Planos', []);
  planos.getRange = () => { throw new Error('hoja caída'); };
  const { sandbox, correosEnviados } = entorno({ hojas: { Planos: planos } });
  ok(sandbox.healthPing() === false, 'con la hoja caída devuelve false');
  ok(correosEnviados.length === 1 && /no responde/.test(correosEnviados[0].subject), 'y manda la alerta por correo');
  sandbox.healthPing();
  ok(correosEnviados.length === 1, 'no inunda el buzón: solo 1 aviso por ventana');
}

grupo('Honeypot y validaciones básicas');
{
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) } });
  ok(post(sandbox, { website: 'bot', correo: 'a@x.com', clave: 'clave-uno' }).error === 'spam', 'el honeypot corta bots');
  ok(post(sandbox, { correo: 'no-es-correo', clave: 'clave-uno' }).error === 'correo_invalido', 'correo inválido se rechaza');
  ok(post(sandbox, { correo: 'a@x.com', clave: 'clave-uno', geom: { nada: 1 } }).error === 'plano_invalido', 'geom sin muros se rechaza');
  ok(resp(sandbox.doGet({ parameter: { action: 'ping' } })).pong === true, 'ping responde');
}

grupo('Embudo: pestaña Eventos (P4)');
{
  const planos = hojaFalsa('Planos', [filaMigrada('ck1', 'ana@x.com', 'clave-uno')]);
  const { sandbox, hojas } = entorno({ hojas: { Planos: planos } });

  const r = post(sandbox, { mode: 'event', client_id: 'c123', eventos: [
    { evento: 'terreno_creado', extra: '10x20' }, { evento: 'primer_elemento', extra: '5' } ] });
  ok(r.ok && r.n === 2, 'un lote de eventos se registra completo');
  const ev = hojas['Eventos'];
  ok(!!ev, 'la pestaña Eventos se crea sola');
  ok(JSON.stringify(ev.celdas[0]) === JSON.stringify(['ts','client_id','evento','extra']),
     'con su encabezado');
  ok(ev.celdas.length === 3, 'quedaron las 2 filas del lote');
  ok(ev.celdas[1][2] === 'terreno_creado' && ev.celdas[1][3] === '10x20', 'con evento y extra');

  // no debe tocar la hoja de planos ni pedir el lock
  const lecturasPlanos = planos.lecturas.length;
  post(sandbox, { mode: 'event', client_id: 'c123', evento: 'nudge_visto' });
  ok(planos.lecturas.length === lecturasPlanos, 'registrar un evento NO lee la hoja de planos');

  // los eventos no necesitan correo ni clave
  ok(post(sandbox, { mode: 'event', client_id: 'c9', evento: 'x' }).ok === true,
     'un evento no exige credenciales (es anónimo)');
  ok(post(sandbox, { mode: 'event', evento: 'x' }).error === 'sin_cliente',
     'pero sí exige client_id');

  // tope de lote
  const muchos = Array.from({ length: 50 }, (_, i) => ({ evento: 'e' + i }));
  const rl = post(sandbox, { mode: 'event', client_id: 'c777', eventos: muchos });
  ok(rl.n === sandbox.CONFIG.MAX_EVENT_LOTE, 'un lote se recorta a 20 eventos', 'n=' + rl.n);
}
{
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) } });
  for (let i = 0; i < sandbox.CONFIG.MAX_EVENT_CLIENTE; i++)
    post(sandbox, { mode: 'event', client_id: 'spam', evento: 'e' });
  ok(post(sandbox, { mode: 'event', client_id: 'spam', evento: 'e' }).error === 'demasiados_intentos',
     'rate-limit por client_id');
}
{
  const { sandbox, cacheRota } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) }, cacheRota: true });
  ok(post(sandbox, { mode: 'event', client_id: 'c1', evento: 'e' }).error === 'demasiados_intentos',
     'fail-closed también en eventos');
}
{
  // volvio_por_correo: el único evento que solo el servidor puede ver
  const planos = hojaFalsa('Planos', [filaMigrada('ck1', 'ana@x.com', 'clave-uno')]);
  const { sandbox, hojas } = entorno({ hojas: { Planos: planos } });
  sandbox.doGet({ parameter: { action: 'plan', id: 'ck1' } });          // sin credenciales
  const ev = hojas['Eventos'];
  ok(ev && ev.celdas.some((f) => f[2] === 'volvio_por_correo'),
     'abrir el enlace del correo deja rastro en Eventos');
  const antes = ev.celdas.length;
  sandbox.doGet({ parameter: { action: 'plan', id: 'ck1', correo: 'ana@x.com', clave: 'clave-uno' } });
  ok(ev.celdas.length === antes, 'abrir CON credenciales no cuenta como "volvió por correo"');
}

grupo('sync no crea proyectos');
{
  const { sandbox } = entorno({ hojas: { Planos: hojaFalsa('Planos', []) } });
  ok(post(sandbox, { mode: 'sync', correo: 'ana@x.com', clave: 'clave-uno', geom: GEOM_REAL }).error === 'no_existe',
     'mode:sync sobre algo inexistente responde no_existe');
}

console.log('\n' + '─'.repeat(52));
console.log(pasadas + ' pasadas · ' + fallidas + ' fallidas');
process.exit(fallidas ? 1 : 0);
