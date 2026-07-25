/* =============================================================
   CroKiss — Harness de pruebas (jsdom)
   Carga index.html COMPLETO con sus scripts locales y verifica
   que la app arranca sin errores de JS y que las piezas clave
   siguen conectadas.

   CroKiss no tiene build ni dependencias en producción: jsdom es
   una herramienta SOLO de pruebas y por eso node_modules/ está en
   .gitignore. Para correrlo:

     mkdir -p /tmp/ck && cd /tmp/ck && npm init -y && npm i jsdom
     cd <repo> && NODE_PATH=/tmp/ck/node_modules node pruebas/harness.js

   Salida: una línea por prueba y código de salida 1 si algo falla.
   ============================================================= */
'use strict';

const path = require('path');
const fs = require('fs');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const RAIZ = path.resolve(__dirname, '..');

/* ---------------- mini framework de aserciones ---------------- */
let pasadas = 0, fallidas = 0;
function ok(cond, nombre, detalle) {
  if (cond) { pasadas++; console.log('  ✓ ' + nombre); }
  else { fallidas++; console.log('  ✗ ' + nombre + (detalle ? '\n      → ' + detalle : '')); }
}
function grupo(nombre) { console.log('\n' + nombre); }

/* ---------------- cargador: solo archivos locales -------------
   La app se monta en la MISMA URL que producción, pero cada script
   se sirve desde el repo local con un interceptor: cero red, cero
   dependencia de GitHub Pages, y las rutas relativas se resuelven
   igual que en el sitio real. Lo externo (Google Fonts) se responde
   vacío para que la prueba sea offline y determinista.            */
const BASE = 'https://alexpueblag.github.io/crokiss/';

const servirLocal = requestInterceptor((request) => {
  const url = request.url;
  if (url.startsWith(BASE)) {
    const rel = decodeURIComponent(url.slice(BASE.length).split(/[?#]/)[0]);
    const abs = path.join(RAIZ, rel);
    // no salir del repo
    if (rel && abs.startsWith(RAIZ) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const tipo = abs.endsWith('.js') ? 'text/javascript'
                 : abs.endsWith('.css') ? 'text/css' : 'text/html';
      return new Response(fs.readFileSync(abs), { headers: { 'Content-Type': tipo } });
    }
    return new Response('', { status: 404 });
  }
  // recurso externo (tipografía): respuesta vacía, nunca red real
  return new Response('', { headers: { 'Content-Type': 'text/css' } });
});

async function main() {
  const htmlPath = path.join(RAIZ, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  /* --- los 8 scripts: 7 externos + 1 en línea --- */
  grupo('Estructura de index.html');
  const externos = [
    'plan-render.js', 'plan-furniture.js', 'plan-editor.js',
    'plan-sheet.js', 'plan-elev.js', 'plan-elev-editor.js', 'crokiss-cloud.js'
  ];
  externos.forEach((f) => {
    ok(html.includes('src="' + f + '"'), 'index.html carga ' + f);
    ok(fs.existsSync(path.join(RAIZ, f)), f + ' existe en el repo');
  });
  const enLinea = (html.match(/<script>/g) || []).length;
  ok(enLinea === 1, 'hay exactamente 1 script en línea (8 scripts en total)', 'encontrados: ' + enLinea);

  /* --- arranque real en jsdom --- */
  const errores = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errores.push(e && e.message ? e.message : String(e)));
  vc.on('error', (m) => errores.push(String(m)));

  const dom = new JSDOM(html, {
    url: BASE,
    runScripts: 'dangerously',
    resources: { interceptors: [servirLocal] },
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const win = dom.window;

  // stubs de red: el harness JAMÁS debe tocar el /exec de producción
  // (cada guardado real es un lead; ver CLAUDE.md).
  let huboRed = false;
  win.fetch = () => { huboRed = true; return Promise.reject(new Error('red bloqueada en pruebas')); };
  win.navigator.sendBeacon = () => { huboRed = true; return false; };
  win.print = () => {};
  win.onerror = (msg) => { errores.push(String(msg)); };

  await new Promise((res) => {
    if (win.document.readyState === 'complete') return res();
    win.addEventListener('load', res);
    setTimeout(res, 4000);                       // red de seguridad
  });

  const doc = win.document;
  const $ = (id) => doc.getElementById(id);

  grupo('Arranque sin errores de JS');
  ok(errores.length === 0, 'cero errores de JavaScript al cargar', errores.join(' | '));
  ok(typeof win.PlanEditor === 'function', 'PlanEditor quedó definido');
  ok(!!win.PlanSheet, 'PlanSheet quedó definido (lámina)');
  ok(!!win.PlanElev, 'PlanElev quedó definido (fachadas)');
  ok(!!win.PlanElevEditor, 'PlanElevEditor quedó definido (editor de fachadas)');
  ok(!!win.CroKiss, 'CroKiss (nube) quedó definido');
  ok(huboRed === false, 'el arranque no golpeó la red');

  /* --- la "super mejora" sigue intacta --- */
  grupo('La super mejora sigue intacta');
  [
    ['advToggle', 'barra Cliente/Avanzado'],
    ['pngBtn', 'exportar PNG'],
    ['redoBtn', 'rehacer'],
    ['labelBtn', 'etiquetas'],
    ['zoomFitBtn', 'zoom ajustar'],
    ['panBtn', 'mover']
  ].forEach(([id, que]) => ok(!!$(id), 'existe #' + id + ' (' + que + ')'));

  // `const ed` en un script clásico es un binding léxico global: existe, pero
  // NO cuelga de window (igual que en el navegador). Se alcanza con eval global.
  const ed = win.eval('typeof ed !== "undefined" ? ed : null');
  ok(!!ed, 'la instancia del editor (const ed) quedó viva en el ámbito global');
  ['exportPNG', 'redo', 'placeLabel', 'zoomFit', 'setPanMode'].forEach((m) =>
    ok(ed && typeof ed[m] === 'function', 'ed.' + m + '() existe'));

  /* --- hooks que la lámina y las fachadas necesitan del motor --- */
  grupo('Hooks del motor para lámina/fachadas');
  ['getGeom', 'setSheet', 'updateElev', 'updateVanoZ'].forEach((m) =>
    ok(ed && typeof ed[m] === 'function', 'ed.' + m + '() existe'));

  const geom = ed.getGeom();
  ok(typeof geom.wallCm === 'number', 'geom.wallCm persiste en el geom', 'valor: ' + geom.wallCm);
  ok(geom.elev && typeof geom.elev.hMuro === 'number', 'geom.elev existe con alturas por defecto');
  ok(geom.elev && geom.elev.cubierta === 'losa', 'geom.elev.cubierta por defecto = losa');

  // updateElev entra al deshacer y cambia el geom
  ed.updateElev({ hMuro: 2.70 });
  ok(ed.getGeom().elev.hMuro === 2.70, 'ed.updateElev() aplica la altura');
  ed.undo();
  ok(ed.getGeom().elev.hMuro === 2.40, 'ed.updateElev() entra al deshacer');

  // el espesor persiste y sobrevive a deshacer/rehacer
  ed.setWallCm(15);
  ok(ed.getGeom().wallCm === 15, 'ed.setWallCm() persiste en el geom');
  ok(ed.getWallCm() === 15, 'ed.getWallCm() refleja el espesor del proyecto');

  /* --- el botón de lámina existe y su handler CORRE --- */
  grupo('Botón Lámina: existe y su handler corre');
  const btnLam = $('btnLamina');
  ok(!!btnLam, 'existe #btnLamina');
  ok(btnLam && !btnLam.closest('.adv'), 'el botón de lámina NO está escondido en Avanzado');
  ok(btnLam && /Lámina/.test(btnLam.textContent), 'el botón dice "Lámina"');

  const erroresAntes = errores.length;
  btnLam.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok(!!$('ck_lamina'), 'al hacer clic se construye el overlay de la lámina (#ck_lamina)');
  const paginas = $('ck_lamina') ? $('ck_lamina').querySelectorAll('.lam-page').length : 0;
  ok(paginas >= 1, 'la lámina generó al menos una página', 'páginas: ' + paginas);
  ok(errores.length === erroresAntes, 'abrir la lámina no lanzó errores',
     errores.slice(erroresAntes).join(' | '));
  const cerrar = $('lam_close'); if (cerrar) cerrar.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  /* --- el botón de fachadas existe y su handler CORRE --- */
  grupo('Botón Fachadas: existe y su handler corre');
  const btnFac = $('btnFachadas');
  ok(!!btnFac, 'existe #btnFachadas');
  ok(btnFac && !btnFac.closest('.adv'), 'el botón de fachadas NO está escondido en Avanzado');
  const erroresAntes2 = errores.length;
  btnFac.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const overlayFac = $('ck_elevedit');
  ok(!!overlayFac, 'al hacer clic se abre el editor de fachadas (#ck_elevedit)');
  const pestanas = overlayFac ? overlayFac.querySelectorAll('.fe-tabs button').length : 0;
  ok(pestanas === 4, 'el editor muestra las 4 orientaciones', 'pestañas: ' + pestanas);
  ok(errores.length === erroresAntes2, 'abrir las fachadas no lanzó errores',
     errores.slice(erroresAntes2).join(' | '));

  /* --- fachadas: el motor genera las 4 orientaciones --- */
  grupo('Motor de fachadas');
  if (win.PlanElev && typeof win.PlanElev.facade === 'function') {
    const g = ed.getGeom();
    ['S', 'N', 'E', 'O'].forEach((d) => {
      let r = null, err = '';
      try { r = win.PlanElev.facade(g, d); } catch (e) { err = e.message; }
      ok(!!r, 'PlanElev.facade(geom, "' + d + '") devuelve resultado', err);
    });
  }

  /* --- versión visible --- */
  grupo('Versión desplegada');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(String(win.CK_VERSION || '')), 'CK_VERSION tiene formato YYYY-MM-DD',
     'valor: ' + win.CK_VERSION);
  ok($('ck_brand') && /versión/.test($('ck_brand').title || ''),
     'la versión es visible en el title del logo', $('ck_brand') && $('ck_brand').title);

  /* ---------------- resultado ---------------- */
  console.log('\n' + '─'.repeat(52));
  console.log(pasadas + ' pasadas · ' + fallidas + ' fallidas');
  win.close();
  process.exit(fallidas ? 1 : 0);
}

main().catch((e) => { console.error('\nEl harness reventó:', e); process.exit(1); });
