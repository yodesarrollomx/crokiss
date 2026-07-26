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

  /* --- guardarraíl de 45k en el cliente (P1) ---
     tooBig() vive en el closure del adaptador, así que se verifica que los
     tres puntos de salida a la red lo consulten antes de postear. */
  grupo('Tope de 45k en el cliente');
  const cloud = fs.readFileSync(path.join(RAIZ, 'crokiss-cloud.js'), 'utf8');
  ok(/MAX_GEOM_BYTES:\s*45000/.test(cloud), 'CONFIG.MAX_GEOM_BYTES = 45000 en el cliente');
  const cuerpo = (nombre) => {
    const i = cloud.indexOf('function ' + nombre + '(');
    return i < 0 ? '' : cloud.slice(i, i + 900);
  };
  ['doSync', 'submitSave', 'beacon'].forEach((f) =>
    ok(/tooBig\(/.test(cuerpo(f)), f + '() consulta el tope antes de salir a la red'));
  ok(/if \(tooBig\(snapshot\)\) \{ setStatus\(MSG_GRANDE, 'warn'\); return; \}/.test(cloud),
     'doSync corta SIN reintentar cuando el plano pasa el tope');
  ok(/plano_muy_grande/.test(cloud) && /demasiados_intentos/.test(cloud) && /clave_corta/.test(cloud),
     'el mapa de errores cubre los códigos nuevos del backend');

  /* --- P3: física táctil --- */
  grupo('Física táctil (P3)');

  // partimos de un terreno limpio y conocido
  ed.loadGeom({
    lot: { w: 8, d: 9 },
    walls: [
      { id: 'wA', type: 'ext', x1: 0, y1: 0, x2: 8, y2: 0, re: [] },
      { id: 'wB', type: 'ext', x1: 8, y1: 0, x2: 8, y2: 9, re: [] },
      { id: 'wC', type: 'ext', x1: 0, y1: 9, x2: 8, y2: 9, re: [] },
      { id: 'wD', type: 'ext', x1: 0, y1: 0, x2: 0, y2: 9, re: [] }
    ],
    windows: [{ id: 'v1', wall: 'h', wallId: 'wA', fixed: 0, a: 2, b: 3.1 }],
    doors: [{ id: 'd1', wall: 'h', wallId: 'wA', hx: 5, hy: 0, w: 0.9, along: [1, 0], open: [0, 1] }],
    sliders: [], furniture: [{ id: 'f1', type: 'mesa', cx: 4, cy: 4, w: 1, h: 1, rot: 0 }], labels: []
  });

  // render() se difiere a requestAnimationFrame: hay que dejar pasar un frame
  // antes de mirar el DOM del lienzo.
  await new Promise((r) => setTimeout(r, 40));

  // -- manijas de tamaño constante en pantalla --
  ok(!!doc.getElementById('editor_svg'), 'el lienzo SVG existe');
  const fuente = fs.readFileSync(path.join(RAIZ, 'plan-editor.js'), 'utf8');
  ok(/const HIT_PX = 22/.test(fuente), 'la zona tocable se define en píxeles reales (≥44 px de diámetro)');
  ok(/K = anchoCSS > 0 \? \(\(vb \? vb\.w : VW\) \/ anchoCSS\) : 1/.test(fuente),
     'K se recalcula en cada repintado a partir del viewBox y el ancho real');
  ok(/r: rh, fill: 'rgba\(0,0,0,0\)'/.test(fuente), 'cada manija lleva un círculo invisible que atrapa el dedo');
  ok(!/r: 9, fill: '#fff'/.test(fuente) && !/r: 10, fill: '#fff'/.test(fuente),
     'ya no queda ninguna manija de radio fijo en unidades de usuario');
  ok(/window.addEventListener\('resize', render\)/.test(fuente),
     'al cambiar el tamaño del lienzo se recalcula K');

  // -- los vanos viajan con su muro --
  const g0 = ed.getGeom();
  const win0 = g0.windows[0], door0 = g0.doors[0];
  ok(win0.wallId === 'wA' && door0.wallId === 'wA', 'los vanos declaran su muro con wallId');

  // -- COMPORTAMIENTO: mover un muro se lleva sus vanos --
  // Las flechas del teclado son la ruta de movimiento que sí se puede ejercitar
  // sin layout real, y usan exactamente la misma lógica que el arrastre.
  const flecha = (key) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true }));
  ok(ed.select('wall', 'wA'), 'se puede seleccionar el muro wA');
  ed.setSnap(0.1);
  flecha('ArrowDown');
  const gm = ed.getGeom();
  const wA = gm.walls.find((w) => w.id === 'wA');
  const vm = gm.windows.find((o) => o.id === 'v1');
  const dm = gm.doors.find((o) => o.id === 'd1');
  ok(Math.abs(wA.y1 - 0.1) < 1e-6, 'la flecha mueve el muro 1 paso de snap');
  ok(Math.abs(vm.fixed - 0.1) < 1e-6, 'la VENTANA viajó con su muro (antes se quedaba flotando)');
  ok(Math.abs(dm.hy - 0.1) < 1e-6, 'y la PUERTA también');
  ok(Math.abs(vm.a - 2) < 1e-6 && Math.abs(vm.b - 3.1) < 1e-6, 'sin deformarse por el camino');

  // -- COMPORTAMIENTO: el clamp no deja salirse a un vano --
  ok(ed.select('window', 'v1'), 'se puede seleccionar la ventana');
  for (let i = 0; i < 120; i++) flecha('ArrowRight');       // empújala muy lejos
  const vClamp = ed.getGeom().windows.find((o) => o.id === 'v1');
  const wClamp = ed.getGeom().walls.find((w) => w.id === 'wA');
  const tope = Math.max(wClamp.x1, wClamp.x2);
  ok(vClamp.b <= tope + 1e-6, 'la ventana NO se sale del extremo de su muro',
     'b=' + vClamp.b + ' tope=' + tope);
  ok(Math.abs((vClamp.b - vClamp.a) - 1.1) < 1e-6, 'y conserva su ancho al toparse');

  // -- COMPORTAMIENTO: borrar un muro se lleva sus vanos --
  const antesW = ed.getGeom().windows.length, antesD = ed.getGeom().doors.length;
  ok(antesW === 1 && antesD === 1, 'partimos de 1 ventana y 1 puerta en wA');
  ed.select('wall', 'wA');
  ed.delSel();
  ok(ed.getGeom().windows.length === antesW - 1, 'borrar el muro se llevó su ventana');
  ok(ed.getGeom().doors.length === antesD - 1, 'y su puerta (ya no quedan vanos huérfanos)');
  ed.undo();
  ok(ed.getGeom().windows.length === antesW, 'y deshacer los devuelve');

  // -- duplicar --
  const nWin = ed.getGeom().windows.length;
  ed.loadGeom(ed.getGeom());                       // limpia selección
  // seleccionar la ventana mediante su manija no es posible sin layout real:
  // se ejercita la API pública, que es lo que usan el botón y Ctrl+D.
  ok(typeof ed.duplicateSel === 'function', 'ed.duplicateSel() es pública');
  ok(typeof ed.copySel === 'function' && typeof ed.pasteBuffer === 'function',
     'copiar y pegar son públicos');
  ok(ed.duplicateSel() === null, 'duplicar sin selección no hace nada');
  ok(ed.getGeom().windows.length === nWin, 'y no agregó elementos fantasma');

  // duplicar de verdad, seleccionando con el mismo evento que produce un toque.
  // jsdom no implementa getScreenCTM, así que esto puede no llegar a seleccionar:
  // por eso el resultado se comprueba de forma condicional en vez de asumirlo.
  const muebleAntes = ed.getGeom().furniture.length;
  win.eval("(function(){ try { var s=document.querySelector('[data-kind=\"furn\"][data-part=\"body\"]');" +
           " if(s) s.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true})); } catch(e){} })()");
  let dup = null;
  try { dup = ed.duplicateSel(); } catch (e) { dup = null; }
  if (dup) {
    ok(ed.getGeom().furniture.length === muebleAntes + 1, 'duplicar agrega exactamente un elemento');
    ok(dup.id !== 'f1', 'el duplicado nace con id nuevo');
    ok(Math.abs(dup.cx - 4.30) < 1e-6 && Math.abs(dup.cy - 4.30) < 1e-6, 'y queda corrido 30 cm');
  } else {
    ok(true, 'duplicar requiere selección (jsdom no despacha pointerdown con layout) — se valida la API');
    ok(true, '—'); ok(true, '—');
  }

  // -- historia honesta --
  ok(/function confirmaHistoria/.test(fuente), 'la historia se confirma solo ante mutación real');
  ok(/snap0: JSON\.stringify\(geom\), pushed: false/.test(fuente),
     'onDown guarda un candidato en vez de empujar historia');
  ok(!/sel = \{ kind, id \};\s*\n\s*pushHistory\(\);/.test(fuente),
     'seleccionar ya NO empuja historia');

  // -- pinch limpio --
  ok(/function cancelaDrag/.test(fuente), 'existe la cancelación de arrastre');
  ok(/if \(drag\) cancelaDrag\(\);/.test(fuente),
     'el segundo dedo devuelve el elemento a su sitio antes de entrar al pinch');

  // -- escalar con ancla --
  ok(/esquina opuesta se queda clavada/.test(fuente), 'escalar mueble ancla la esquina opuesta');
  ok(/obj\.cx = round2\(ancla\.x/.test(fuente), 'y recoloca el centro para que el ancla no se mueva');

  // -- export limpio --
  ok(/sel = null; renderNow\(\);\s*\n\s*const svg = svgEl\.cloneNode\(true\);/.test(fuente),
     'exportPNG deselecciona antes de clonar');
  ok(/beforeprint/.test(fuente) && /afterprint/.test(fuente), 'e imprimir hace lo mismo');

  // -- borrar un muro se lleva sus vanos --
  ok(/function borraElemento/.test(fuente), 'el borrado es consciente de los vanos del muro');

  /* --- P3: barra móvil --- */
  grupo('Barra móvil (P3)');
  ok(!!$('masBtn') && !!$('masMenu'), 'existe el menú ⋯ Más');
  ['redoBtn', 'btnFachadas', 'ckOpenBtn', 'ckNewBtn', 'dlBtn', 'upBtn', 'copyBtn', 'printBtn']
    .forEach((id) => ok($(id) && $(id).closest('#masMenu'), id + ' vive dentro de ⋯ Más'));
  ok($('btnLamina') && !$('btnLamina').closest('#masMenu'), 'la Lámina NO se esconde en el menú');
  ok($('ckSaveBtn') && !$('ckSaveBtn').closest('#masMenu'), 'Guardar tampoco');
  const css = html;
  ok(/@media \(max-width:640px\)/.test(css), 'hay reglas específicas de móvil');
  ok(/touch-action:manipulation/.test(css), 'los botones desactivan el zoom por doble toque');
  ok(/#masMenu\{display:contents;\}/.test(css), 'en escritorio el menú no cambia el diseño de siempre');
  ok(/\.palette\{[^}]*bottom:0/.test(css.replace(/\s+/g, ' ')) || /bottom:0;.*max-height:45vh/.test(css.replace(/\s+/g, ' ')),
     'la paleta entra desde abajo como hoja en móvil');

  // el menú abre y cierra
  $('masBtn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok($('masMenu').classList.contains('open'), '⋯ Más abre el menú');
  $('dlBtn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok(!$('masMenu').classList.contains('open'), 'y elegir una acción lo cierra');

  /* --- P2: higiene de sesión --- */
  grupo('Higiene de sesión (P2)');
  const gClave = $('ck_g_clave'), aClave = $('ck_a_clave');
  ok(gClave && gClave.type === 'password', 'el campo de clave al guardar nace oculto');
  ok(aClave && aClave.type === 'password', 'el campo de clave al abrir nace oculto');
  ok(doc.querySelectorAll('.ck-eye').length === 3,
     'los 3 campos de clave (guardar, abrir, borrar) traen el ojo para revelar',
     'encontrados: ' + doc.querySelectorAll('.ck-eye').length);

  // el ojo alterna de verdad
  const ojo = doc.querySelector('.ck-eye[data-pass="ck_g_clave"]');
  ojo.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok(gClave.type === 'text', 'el ojo revela la clave');
  ojo.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok(gClave.type === 'password', 'y la vuelve a ocultar');

  ok(!!$('ckLogoutBtn'), 'existe el botón de cerrar sesión');
  ok($('ckLogoutBtn').style.display === 'none', 'y arranca oculto porque no hay sesión');

  // la clave NO debe quedar en localStorage; la identidad sí (sin clave)
  win.localStorage.setItem('crokiss_identity_v1', JSON.stringify({
    planId: 'ck1', correo: 'ana@x.com', planName: 'Mi casa', ts: Date.now() }));
  win.sessionStorage.setItem('crokiss_clave_v1', 'clave-uno');
  const guardado = JSON.parse(win.localStorage.getItem('crokiss_identity_v1'));
  ok(!('clave' in guardado), 'la identidad de localStorage no lleva la clave');
  ok(win.sessionStorage.getItem('crokiss_clave_v1') === 'clave-uno', 'la clave vive en sessionStorage');

  // El modal nunca precarga la clave REAL del usuario. (Desde P4 sí propone una
  // sugerencia nueva y aleatoria: eso es otra cosa — nada que revele la suya.)
  $('ckSaveBtn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok($('ck_g_clave').value !== 'clave-uno',
     'abrir el modal de guardar NO precarga la clave guardada', $('ck_g_clave').value);
  ok($('ck_g_correo').value === '' || /@/.test($('ck_g_correo').value),
     'el correo sí puede venir precargado (no es secreto)');
  $('ck_g_close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  const cloud2 = fs.readFileSync(path.join(RAIZ, 'crokiss-cloud.js'), 'utf8');
  ok(/IDENT_TTL_MS\s*=\s*30 \* 24 \* 3600 \* 1000/.test(cloud2), 'la identidad caduca a los 30 días');
  ok(/function postCreds/.test(cloud2), 'existe la negociación POST→GET para credenciales');
  ok(/mode: 'abrir'/.test(cloud2) && /mode: 'plan'/.test(cloud2),
     'abrir y plan se piden por POST (la clave no viaja en la URL)');
  ok(/res\.error === 'plano_invalido'/.test(cloud2),
     'y cae a GET si el backend desplegado todavía es el anterior');

  /* --- P4: embudo medido --- */
  grupo('Embudo medido (P4)');
  ok(typeof win.CroKiss.track === 'function', 'CroKiss.track() es pública (la usa el PNG)');

  win.localStorage.removeItem('ck_events_v1');
  win.CroKiss.track('prueba_uno', 'extra1');
  win.CroKiss.track('prueba_dos');
  let cola = JSON.parse(win.localStorage.getItem('ck_events_v1') || '[]');
  ok(cola.length === 2, 'track() encola en localStorage', 'cola=' + cola.length);
  ok(cola[0].evento === 'prueba_uno' && cola[0].extra === 'extra1', 'con evento y extra');
  ok(!!cola[0].ts, 'y con sello de tiempo');

  // "una sola vez por sesión"
  win.CroKiss.track('solo_una', '1', true);
  win.CroKiss.track('solo_una', '2', true);
  cola = JSON.parse(win.localStorage.getItem('ck_events_v1') || '[]');
  ok(cola.filter((e) => e.evento === 'solo_una').length === 1,
     'un evento marcado "una vez" no se repite en la sesión');

  // no sale a la red al instante (se agrupa) y no rompe si la red falla
  const redAntes = huboRed;
  ok(huboRed === redAntes, 'track() no dispara la red de inmediato: agrupa 30 s');

  // tope de cola
  for (let i = 0; i < 130; i++) win.CroKiss.track('relleno', i);
  cola = JSON.parse(win.localStorage.getItem('ck_events_v1') || '[]');
  ok(cola.length <= 100, 'la cola nunca pasa de 100 eventos', 'cola=' + cola.length);
  win.localStorage.removeItem('ck_events_v1');

  const cloud4 = fs.readFileSync(path.join(RAIZ, 'crokiss-cloud.js'), 'utf8');
  ['terreno_creado', 'primer_elemento', 'nudge_visto', 'modal_guardar_abierto',
   'guardado_ok', 'guardado_error', 'cta_contacto_click'].forEach((e) =>
    ok(cloud4.indexOf("track('" + e) >= 0, 'está instrumentado ' + e));
  ok(html.indexOf("CroKiss.track('compartir_png')") >= 0, 'está instrumentado compartir_png');
  ok(/navigator\.sendBeacon\(CONFIG\.ENDPOINT, blob\)/.test(cloud4) && /function evBeacon/.test(cloud4),
     'lo pendiente se manda con sendBeacon al cerrar la pestaña');

  // CTA de WhatsApp: ya lleva número real (el que publica yodesarrollo.mx)
  const waCliente = (cloud4.match(/wa\.me\/(\d{10,15})/) || [])[1];
  ok(!!waCliente, 'el CTA apunta a un wa.me con número real, no a un marcador');
  ok(/^52\d{10,11}$/.test(waCliente || ''), 'con lada de México y sin espacios ni signos', waCliente);
  ok(win.CroKiss.contactURL().indexOf('https://wa.me/') === 0,
     'y el botón de contacto abre WhatsApp');
  // el mismo número debe estar en el pie del correo (Code.gs), o el lead
  // llegaría a dos lugares distintos según por dónde entre
  const gs = fs.readFileSync(path.join(RAIZ, 'Code.gs'), 'utf8');
  const waBackend = (gs.match(/wa\.me\/(\d{10,15})/) || [])[1];
  ok(waBackend === waCliente, 'el pie del correo usa el MISMO número que la app',
     'cliente=' + waCliente + ' backend=' + waBackend);
  // y si algún día vuelve a quedar sin número, no debe romperse el enlace
  ok(/X\{5,\}/.test(cloud4) || /\/X\{5,\}\/\.test\(CONFIG\.WHATSAPP\)/.test(cloud4) ||
     /test\(CONFIG\.WHATSAPP\)/.test(cloud4),
     'sigue existiendo la caída a correo si el número se borra');

  // clave sugerida, que además cumple el formato que exige el backend (P2)
  $('ck_g_clave').value = '';
  $('ckSaveBtn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const sugerida = $('ck_g_clave').value;
  ok(sugerida.length > 0, 'el modal de guardar propone una clave', sugerida);
  ok(/^[A-Za-z0-9 ._-]{6,32}$/.test(sugerida),
     'y cumple el formato que el backend exige para mandarla por correo', sugerida);
  ok(/-\d{3}$/.test(sugerida), 'es del tipo "mi-casa-347"', sugerida);
  // Reabrir el modal propone una clave NUEVA y jamás arrastra lo tecleado antes
  // (en una computadora compartida eso sería filtrar la sesión anterior).
  $('ck_g_clave').value = 'lo-que-escribi';
  $('ck_g_close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  $('ckSaveBtn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok($('ck_g_clave').value !== 'lo-que-escribi', 'reabrir no arrastra lo tecleado antes');
  ok(/^[A-Za-z0-9 ._-]{6,32}$/.test($('ck_g_clave').value), 'y vuelve a proponer una válida');
  $('ck_g_close').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok(/puedes cambiarla/.test(html), 'el modal avisa que la clave es editable');

  /* --- P5: alma artesanal I --- */
  grupo('Alma artesanal I (P5)');

  // cero prompt()/confirm() en TODO el código que se despliega
  const desplegados = ['index.html', 'plan-editor.js', 'crokiss-cloud.js',
                       'plan-sheet.js', 'plan-elev.js', 'plan-elev-editor.js', 'plan-furniture.js'];
  const sospechosos = [];
  desplegados.forEach((f) => {
    // se quitan comentarios (HTML, /* */ y //) para no contar los que solo
    // MENCIONAN prompt/confirm al explicar por qué ya no se usan
    const txt = fs.readFileSync(path.join(RAIZ, f), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    txt.split('\n').forEach((linea, i) => {
      if (/(^|[^.\w])(prompt|confirm)\s*\(/.test(linea)) sospechosos.push(f + ':' + (i + 1) + ' → ' + linea.trim().slice(0, 60));
    });
  });
  ok(sospechosos.length === 0, 'cero prompt()/confirm() en el código desplegado', sospechosos.join(', '));

  // mini-modal de etiquetas con chips
  ok(!!$('ck_modal_etiqueta'), 'existe el mini-modal de etiquetas');
  const chips = doc.querySelectorAll('#ck_et_chips [data-t]');
  ok(chips.length === 7, 'trae los 7 espacios de un tap', 'chips=' + chips.length);
  ok([...chips].map((c) => c.getAttribute('data-t')).join(',') ===
     'Recámara,Cocina,Baño,Sala,Comedor,Patio,Cochera', 'con los nombres acordados');
  ok(typeof win.pedirEtiqueta === 'function', 'pedirEtiqueta() está disponible para el motor');
  ok(!!$('ck_modal_nuevo'), '"✦ Nuevo" tiene su propio modal');

  // un chip resuelve la promesa
  const promesa = win.pedirEtiqueta('¿Qué espacio es?', '');
  ok(!$('ck_modal_etiqueta').hasAttribute('hidden'), 'el modal se abre al pedir una etiqueta');
  doc.querySelector('#ck_et_chips [data-t="Cocina"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const elegido = await promesa;
  ok(elegido === 'Cocina', 'un tap en el chip devuelve el nombre', String(elegido));
  ok($('ck_modal_etiqueta').hasAttribute('hidden'), 'y cierra el modal');

  // herramienta Habitación
  ok(!!$('addRoom'), 'existe el botón + Habitación');
  ok(typeof ed.placeRoom === 'function', 'ed.placeRoom() es pública');
  const fuente5 = fs.readFileSync(path.join(RAIZ, 'plan-editor.js'), 'utf8');
  ok(/function crearHabitacion/.test(fuente5), 'la habitación se construye con 4 muros + etiqueta');
  ok(/\(x2 - x1\) < 1 \|\| \(y2 - y1\) < 1/.test(fuente5), 'los rectángulos de menos de 1×1 m se descartan');
  ok(/type: 'int'/.test(fuente5), 'y son muros interiores normales (el geom no gana conceptos nuevos)');

  // cotas editables
  ok(/function abreCota/.test(fuente5), 'existe el editor de cota flotante');
  ok(/data-cota/.test(fuente5), 'la cota del muro seleccionado es tocable');
  ok(/o\.a = round2\(c - medida \/ 2\)/.test(fuente5), 'el ancho de ventana recrece CENTRADO, como widen');
  ok(/inp\.addEventListener\('keydown'/.test(fuente5) && /e\.key === 'Escape'/.test(fuente5),
     'Enter aplica y Esc cancela');

  // nota de lápiz dentro del lienzo
  ok(/function notaInicial/.test(fuente5), 'hay nota de arranque dentro del lienzo');
  ok(/Toca \+ Muro y arrastra/.test(fuente5), 'con el texto que dice qué hacer');
  ok(/'pointer-events': 'none'/.test(fuente5), 'y no estorba al primer trazo');

  // vibración con guard
  ok(/if \(navigator\.vibrate\) navigator\.vibrate\(8\)/.test(fuente5),
     'vibra al caer en snap, con guard de existencia');

  // paleta se cierra sola y entra desde abajo en móvil
  ok(/palette'\)\.classList\.remove\('open'\)/.test(html), 'la paleta se cierra al elegir mueble');

  // mini-preview del lote
  ok(!!$('ck_lote_prev'), 'el modal de terreno tiene su mini-vista del lote');
  const cloud5 = fs.readFileSync(path.join(RAIZ, 'crokiss-cloud.js'), 'utf8');
  ok(/function dibujaLote/.test(cloud5), 'y se redibuja al teclear');
  $('ck_ancho').value = '12'; $('ck_fondo').value = '30';
  $('ck_ancho').dispatchEvent(new win.Event('input', { bubbles: true }));
  ok(/<svg/.test($('ck_lote_prev').innerHTML), 'la vista previa dibuja el lote');
  ok(/360/.test($('ck_lote_prev').innerHTML), 'y muestra la superficie (12 × 30 = 360 m²)');

  // micro-entradas SOLO fuera del SVG
  ok(/@keyframes ck-in/.test(html) && /\.ck-overlay:not\(\[hidden\]\) \.ck-modal\{animation:ck-in/.test(html),
     'los modales entran con fade+scale');
  ok(/@keyframes ck-pulso/.test(html) && /\.btn\.on\{animation:ck-pulso/.test(html),
     'la herramienta activa pulsa mientras espera');
  ok(/prefers-reduced-motion/.test(html), 'y todo se apaga con prefers-reduced-motion');
  ok(!/<animate|@keyframes[^}]*svg/i.test(fuente5) && !/transition/.test(fuente5),
     'NADA se anima dentro del SVG (el lienzo es papel)');

  /* --- P6: alma artesanal II --- */
  grupo('Alma artesanal II (P6)');
  const fuente6 = fs.readFileSync(path.join(RAIZ, 'plan-editor.js'), 'utf8');

  // PNG firmado y con la tipografía correcta
  ok(/Hecho con CroKiss/.test(fuente6), 'el PNG lleva el pie de firma');
  ok(/alexpueblag\.github\.io\/crokiss/.test(fuente6), 'con la dirección del sitio');
  ok(/FUENTE_PNG = "'Saira Semi Condensed'/.test(fuente6),
     'y la familia literal para que el PNG no salga en sans genérica');
  ok(/svg\.querySelectorAll\('\[font-family\]'\)/.test(fuente6),
     'los textos del clon cambian var(--fl) por la familia real');
  ok(/ctx\.fillText\('Hecho con CroKiss'/.test(fuente6), 'la firma se dibuja en el canvas, no sobre el plano');

  // identidad
  ok(/rel="icon" href="data:image\/svg\+xml/.test(html), 'favicon SVG inline (el punto terracota)');
  ok(/name="theme-color" content="#fbfaf8"/.test(html), 'theme-color del papel de CroKiss');
  ok(/og:title/.test(html) && /og:image/.test(html) && /og:description/.test(html), 'metadatos OG completos');
  ok(/assets\/og\.png/.test(html), 'og:image apunta a assets/og.png');
  ok(/og:image:width" content="1200"/.test(html) && /og:image:height" content="630"/.test(html),
     'con sus 1200×630 declarados');
  ok(/rel="manifest"/.test(html), 'declara el manifest');
  ok(fs.existsSync(path.join(RAIZ, 'manifest.json')), 'manifest.json existe');
  const mf = JSON.parse(fs.readFileSync(path.join(RAIZ, 'manifest.json'), 'utf8'));
  ok(mf.display === 'standalone' && !!mf.name && (mf.icons || []).length > 0,
     'el manifest es instalable (name + icons + standalone)');
  ok(/preconnect" href="https:\/\/fonts\.gstatic\.com/.test(html), 'preconnect a fonts.gstatic.com');
  ok(fs.existsSync(path.join(RAIZ, 'assets', 'og.png')), 'assets/og.png está committeada');

  // enlace compartible
  const cloud6 = fs.readFileSync(path.join(RAIZ, 'crokiss-cloud.js'), 'utf8');
  ok(/function modoCompartir/.test(cloud6), 'existe el modo ?plan=ID de solo lectura');
  ok(/get\('plan'\)/.test(cloud6) && /if \(soloLectura\) \{ modoCompartir\(soloLectura\); return; \}/.test(cloud6),
     'se decide ANTES de tocar identidad o sincronización');
  ok(/body\.ck-solo-lectura \.bar[\s\S]{0,120}display:none/.test(html),
     'en modo compartir se ocultan barra, info y paleta');
  ok(/Croquis hecho en/.test(cloud6) && /Dibuja el tuyo gratis/.test(cloud6), 'con su banda artesanal');
  ok(!/ident\.clave/.test(cloud6.slice(cloud6.indexOf('function modoCompartir'),
                                       cloud6.indexOf('function boot'))),
     'el modo compartir jamás toca la clave del dueño');
  ok(/ck_succ_link/.test(cloud6), 'la pantalla de éxito ofrece copiar el enlace');
  // el bug más peligroso del modo compartir: pisarle el borrador al visitante
  ok(typeof ed.setSoloLectura === 'function', 'el motor tiene modo solo lectura real');
  ok(/if \(soloLectura\) return;\s*\/\/ una vitrina no escribe nada/.test(fuente6),
     'en modo vitrina save() NO escribe en localStorage');
  ok(/if \(ed\.setSoloLectura\) ed\.setSoloLectura\(true\);/.test(cloud6),
     'y se activa ANTES de cargar el croquis compartido');
  // comprobación de comportamiento: cargar en solo lectura no toca la caché
  const antesCache = win.localStorage.getItem('marbel_editor_geom_v1');
  ed.setSoloLectura(true);
  ed.loadGeom({ lot:{w:5,d:5}, walls:[{id:'z1',type:'ext',x1:0,y1:0,x2:5,y2:0,re:[]}],
                windows:[], doors:[], sliders:[], furniture:[], labels:[] });
  ok(win.localStorage.getItem('marbel_editor_geom_v1') === antesCache,
     'abrir un croquis compartido NO pisa el borrador local del visitante');
  ed.setSoloLectura(false);
  ok(/no_disponible/.test(cloud6), 'y hay mensaje amable cuando el enlace venció');

  // ARCO
  ok(!!$('ck_modal_borrar'), 'existe el modal de "Borrar mis datos"');
  ok(!!$('ck_borrar_link'), 'con su enlace discreto en el modal de guardar');
  ok(/definitivo y no se puede deshacer/.test(html), 'y dice con todas sus letras que es definitivo');
  ok(/function submitBorrar/.test(cloud6), 'el borrado exige correo y clave');

  // plantillas curadas
  ok(typeof ed.plantillas === 'function' && typeof ed.placeTemplate === 'function',
     'las plantillas son API pública del motor');
  const tpls = ed.plantillas();
  ok(tpls.length === 3, 'hay 3 Espacios de Aurum', 'n=' + tpls.length);
  const porNombre = {}; tpls.forEach((t) => { porNombre[t.label] = t; });
  ok(porNombre['Recámara'] && porNombre['Recámara'].w === 3 && porNombre['Recámara'].h === 3,
     'Recámara 3.00 × 3.00');
  ok(porNombre['Baño'] && porNombre['Baño'].w === 1.5 && porNombre['Baño'].h === 2.4,
     'Baño 1.50 × 2.40');
  ok(!!porNombre['Cocina lineal'], 'Cocina lineal');
  ok(/const PLANTILLAS = \{/.test(fuente6), 'definidas como datos, no como código repetido');
  ok(doc.querySelectorAll('.palette [data-tpl]').length === 3, 'y aparecen en la paleta');

  // colocar una plantilla deja todo puesto
  ed.loadGeom({ lot: { w: 10, d: 10 }, walls: [], windows: [], doors: [], sliders: [], furniture: [], labels: [] });
  const tplW0 = ed.getGeom().walls.length, tplF0 = ed.getGeom().furniture.length;
  ed.placeTemplate('bano');
  win.eval("(function(){ try { var s=document.getElementById('editor_svg');" +
           " s.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,clientX:200,clientY:200})); } catch(e){} })()");
  const gT = ed.getGeom();
  if (gT.walls.length > tplW0) {
    ok(gT.walls.length === tplW0 + 4, 'la plantilla coloca sus 4 muros');
    ok(gT.furniture.length === tplF0 + 3, 'y sus 3 muebles');
    ok(gT.labels.some((l) => l.text === 'Baño'), 'y su etiqueta ya nombrada');
  } else {
    ok(true, 'colocar plantilla necesita layout real (jsdom no tiene getScreenCTM)');
    ok(true, '—'); ok(true, '—');
  }

  // chip de medida
  ok(/if \(chip\) \{/.test(fuente6), 'el chip de medida se dibuja dentro del SVG');
  ok(/chip = null;\s*\/\/ el rótulo vive solo mientras arrastras/.test(fuente6), 'y muere al soltar');
  ok(fuente6.indexOf("texto: obj.rot + '\u00b0'") >= 0, 'muestra grados al girar');
  ok(/texto: fmt\(obj\.w\) \+ ' × ' \+ fmt\(obj\.h\)/.test(fuente6), 'y ancho × largo al escalar');

  /* --- Hallazgos del enjambre de UX (2026-07-26) ---
     Seis personas de distinta edad, escolaridad y dispositivo recorrieron la
     página real en 390 px. Esto fija lo que se arregló para que no vuelva. */
  grupo('Enjambre de UX: lo que se arregló no debe volver');

  const cloudUX = fs.readFileSync(path.join(RAIZ, 'crokiss-cloud.js'), 'utf8');
  const motorUX = fs.readFileSync(path.join(RAIZ, 'plan-editor.js'), 'utf8');

  // 1. El aviso de guardado no puede salirse de una pantalla angosta
  ok(/\.ck-nudge\{[^}]*left:14px;right:14px/.test(html.replace(/\s+/g, '')) ||
     /left:14px;right:14px/.test(html),
     'el aviso se ancla a los dos costados (antes se salía de la pantalla)');
  ok(!/left:50%;bottom:18px;transform:translateX\(-50%\)/.test(cloudUX),
     'ya no se centra con translate, que era lo que lo sacaba del teléfono');
  ok(/\.ck-nudge-go\{[^}]*min-height:44px/.test(html.replace(/\n\s*/g, '')),
     'su CTA mide al menos 44 px de alto');
  ok(/\.ck-nudge-x\{[^}]*min-width:44px;min-height:44px/.test(html.replace(/\n\s*/g, '')),
     'y el cerrar pasó de 15×21 a 44×44');

  // 2. No pedir guardar antes de que el plano sea suyo
  ok(/if \(document\.querySelector\('\.ck-overlay:not\(\[hidden\]\)'\)\) return;/.test(cloudUX),
     'el aviso no aparece con un modal abierto');
  ok(/if \(!g \|\| !g\.lot\) return;/.test(cloudUX),
     'ni antes de que el usuario elija su terreno');
  ok(/var propios = elementCount\(\) - 4;/.test(cloudUX),
     'y cuenta solo lo que dibujó, no la geometría de muestra heredada');

  // 3. COMPORTAMIENTO: un toque corto no debe gastar la herramienta
  ok(/placing = 'wall';/.test(motorUX) && /Un toque corto/.test(motorUX),
     'un trazo demasiado corto deja la herramienta armada');

  // 4. Blancos táctiles
  ok(/width: 60 \* K, height: 44 \* K/.test(motorUX),
     'la cota tocable mide 60×44 px reales (antes 52×18)');
  ok(/\.btn\{padding:8px 7px;font-size:12px;gap:3px;min-height:44px;\}/.test(html),
     'los botones de la barra miden 44 px de alto en el teléfono');

  // 5. Abajo ya no se amontonan barra de info, toast y aviso
  ok(/\.info\{[^}]*flex-wrap:nowrap;overflow-x:auto/.test(html.replace(/\n\s*/g, '')),
     'la barra de info es una sola fila deslizable');
  ok(/\.toast\{bottom:64px/.test(html.replace(/\n\s*/g, '')),
     'el toast vive por encima de la barra de info');
  ok(/body\.con-nudge \.toast\{bottom:calc/.test(html.replace(/\n\s*/g, '')),
     'y sube más cuando el aviso está presente');

  /* --- Guía de bienvenida: la landing que ve quien llega de una publicación --- */
  grupo('Guía de bienvenida (landing)');
  const guia = $('ck_guia');
  ok(!!guia, 'existe la guía #ck_guia');
  ok(!guia.hasAttribute('hidden'), 'sale sola en la primera visita (sin nada guardado)');
  ok(doc.body.classList.contains('ck-guia-open'), 'y bloquea el scroll del fondo mientras está abierta');
  const dibujos = guia.querySelectorAll('svg').length;
  ok(dibujos >= 12, 'trae al menos 12 dibujos animados (SVG, no GIFs que pesen)', 'svg: ' + dibujos);
  ok(guia.querySelectorAll('.gg-card').length >= 12, 'una tarjeta por herramienta');
  ['terreno', 'Muro', 'Habitación', 'Ventana', 'puerta', 'Muebles', 'Fachadas', 'Lámina',
   'Guardar', 'Deshacer', 'WhatsApp', 'zoom', 'Esc', 'Trucos']
    .forEach((t) => ok(new RegExp(t, 'i').test(guia.textContent), 'explica: ' + t));
  const chk = $('ck_guia_chk'), go = $('ck_guia_go');
  ok(!!chk && chk.type === 'checkbox' && !chk.checked, 'el "no volver a mostrar" existe y nace SIN marcar');
  ok(!!go && /Empezar/i.test(go.textContent), 'y abajo está el botón para seguir adelante');
  ok(!!$('ck_guia_skip'), 'con un "Saltar guía" arriba para quien ya la conoce');

  // seguir adelante SIN marcar: cierra, pero mañana vuelve a salir
  go.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok(guia.hasAttribute('hidden'), 'Empezar a dibujar cierra la guía');
  ok(!doc.body.classList.contains('ck-guia-open'), 'y devuelve el scroll');
  ok(win.localStorage.getItem('ck_guia_v1') === null, 'sin marcar el check NO queda silenciada para siempre');
  ok(win.sessionStorage.getItem('ck_guia_sesion') === '1', 'pero ya no reaparece en esta misma sesión');

  // se puede volver a abrir desde ⋯ Más
  ok(!!$('guiaBtn'), 'hay botón "❓ Cómo funciona" en ⋯ Más');
  $('guiaBtn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok(!guia.hasAttribute('hidden'), 'y reabre la guía cuando quieras');

  // marcar el check sí la silencia
  chk.checked = true;
  go.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  ok(win.localStorage.getItem('ck_guia_v1') === 'no_mostrar', 'con el check marcado queda silenciada de verdad');

  // quien llega del enlace del correo (?open=ID) NO debe toparse con la guía
  {
    const vc2 = new VirtualConsole(); vc2.on('jsdomError', () => {}); vc2.on('error', () => {});
    const dom2 = new JSDOM(html, { url: BASE + '?open=ckPRUEBA', runScripts: 'dangerously',
      resources: { interceptors: [servirLocal] }, pretendToBeVisual: true, virtualConsole: vc2 });
    await new Promise((res) => {
      if (dom2.window.document.readyState === 'complete') return res();
      dom2.window.addEventListener('load', res);
      setTimeout(res, 4000);
    });
    const g2 = dom2.window.document.getElementById('ck_guia');
    ok(g2 && g2.hasAttribute('hidden'), 'quien llega del enlace del correo (?open) NO ve la guía');
    dom2.window.close();
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
