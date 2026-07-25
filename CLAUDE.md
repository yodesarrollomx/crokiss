# CroKiss — "El primer beso con tu proyecto"

Editor de planos 2D embebible (muros, ventanas, puertas, corredizas, muebles, etiquetas de espacio) que parte del tamaño del terreno. Herramienta pública y gratuita embebida en el portal de Yodesarrollo; imán de prospectos para Aurum/Yodesarrollo: al guardar, el usuario deja correo + clave y recibe su plano por correo con enlace para volver. Cada guardado = un lead. Métrica de uso = correos distintos.

## Estado actual (2026-07-25) — CK_VERSION `2026-07-25`

Core funcional de punta a punta y publicado, con la "super mejora" (auditoría de 3 expertos) **y** la lámina/fachadas de junio, que estuvieron desconectadas y **volvieron en este rescate (P0)**.

`index.html` declara `CK_VERSION` (visible en el `title` del logo y en `window.CK_VERSION`): **súbela en cada despliegue** para saber siempre qué corre en producción.

### ⚠️ Regla de oro del repo: NUNCA desplegar desde zips

Los commits `dcbd102` y `975b699` se construyeron desde copias/zips viejos en vez de sobre `main`, y **sepultaron trabajo ya terminado tres veces**:

1. `dcbd102` subió un `index.html` de un zip anterior a `7be88d8` → se cayeron los `<script>` de `plan-sheet.js`/`plan-elev.js`/`plan-elev-editor.js` y los botones de Lámina/Fachadas. Los archivos seguían en el repo, pero **nada los cargaba**.
2. La reescritura de `plan-editor.js` borró los hooks que esas piezas necesitan (`setSheet`, `updateElev`, `updateVanoZ`) y la persistencia de `geom.wallCm` / `geom.elev`.
3. `975b699` revirtió **byte a byte** el hasheo SHA-256 de `ec6d029`: el `Code.gs` de `main` volvió a ser idéntico al de `dcbd102`.

**Siempre:** `git pull` → editar sobre el árbol de trabajo → `git commit` → `git push`. Nunca reconstruir un archivo desde una descarga y subirlo encima. Si un archivo "se ve viejo", compáralo con `git show <commit>:<archivo>` antes de sobrescribirlo.

### Rescate P0 (2026-07-25)

- Reintegrados los 3 `<script>` de lámina/fachadas sobre el `index.html` actual, **sin perder nada de la super mejora**.
- Botones **📐 Lámina** y **🏠 Fachadas** en la barra, visibles (no dentro de ⚙ Avanzado).
- Restaurados en `plan-editor.js`: `setSheet`, `updateElev`, `updateVanoZ`, `getWallCm`, `DEF_ELEV`, y la persistencia de `geom.wallCm`/`geom.elev` en `normalize()` (así sobreviven a deshacer/rehacer). El resumen vuelve a reportar alturas.
- La barra sincroniza el espesor con el del proyecto al arrancar (antes mostraba un "20 cm" fijo aunque el plano fuera otro).
- Harness jsdom nuevo en `pruebas/harness.js`: **62 pruebas verdes**.

## Super mejora 2026-07 (implementada y validada con 35 pruebas jsdom)

**Motor (`plan-editor.js`):**
- Integridad: `normalize()` sanea todo el geom importado/de nube — clamp de `blockLen>=0.10` y `joint>=0` (arregla el cuelgue por loop infinito en `wallBlocks`), filtra coordenadas no finitas, limpia ids/types (`[A-Za-z0-9_-]`), estampa `schemaVersion`. `loadGeom()` ahora vacía el historial (`clearHistory`) para que Deshacer NO traiga geometría de otro proyecto (evitaba corrupción en la nube).
- Punteros robustos: filtra por `isPrimary`/`pointerId`, registra `pointercancel` en drag y pan (no más arrastres "pegados" en táctil).
- **Pinch-zoom y pan con 2 dedos** (móvil/tablet) además del Ctrl/⌘+rueda.
- **Rehacer** (`redo`) + atajo Ctrl/⌘+Z / Shift+Z. Escape cancela la colocación de un elemento.
- `requestAnimationFrame` coalescing de `render()` (menos jank en arrastres).
- Manijas de selección más grandes (r 6/7 → 9/10) para dedos.
- **Etiquetas de espacio** (`geom.labels`: {id,cx,cy,text}) — Recámara, Cocina, Baño… se dibujan, se mueven, se borran (texto escapado contra XSS).
- **Exportar PNG** (`exportPNG`) para compartir por WhatsApp.
- Resumen ("Copiar") rebrandeado a "CroKiss · Aurum" (era "Proyecto Marbel") y sin volcar el JSON crudo.

**Nube (`crokiss-cloud.js`):**
- Arreglado `?open=ID` del correo: antes abría "en falso" (sync con credenciales vacías y reintentos infinitos). Ahora abre en modo borrador y pide la clave al guardar para re-vincular.
- Sync: reintento con backoff exponencial, retry si llega un cambio durante un sync en vuelo, y NO reintenta el error permanente `no_autorizado`.
- **Nudge de guardado** (banner no modal) tras ~8 elementos o 3 min sin reclamar → capta el lead.
- **Pantalla de éxito** post-guardado con la clave, aviso de revisar spam y CTA "¿Quieres que Aurum convierta tu croquis en proyecto?" (mailto configurable en `CONFIG.CONTACT_URL`).
- El modal de guardar ya NO se cierra por clic afuera (no se pierde lo tecleado).

**UI (`index.html`):**
- Barra en dos niveles: **modo Cliente** por defecto (Muro, Ventana, Puerta, Corrediza, Muebles, Etiqueta, Zoom, Guardar, PNG, Deshacer/Rehacer) y botón **⚙ Avanzado** que despliega block/junta/refuerzos/espesor/Snap (`.adv`).
- `Muro de block` apagado por defecto (muro sólido, más simple). "Ver plano final →" oculto (estaba roto).
- Marketing **opt-in** (sin premarcar) + enlace a **aviso de privacidad** (LFPDPPP).
- Modales con `role="dialog"`, Esc para cerrar, Enter para enviar, autofocus; `:focus-visible`.
- Indicador de herramienta activa (`.on`), toasts más largos (3.2 s), hint táctil.
- Catálogo (`plan-furniture.js`): + regadera, lavadora, escalera, auto (cochera).

**Backend (`Code.gs`) — endurecido (requiere re-desplegar el Apps Script, ver Despliegue):**
- Antiinyección de fórmulas en Sheets (`_safeCell`: neutraliza celdas que empiezan con `= + - @`).
- `doGet plan` ya NO devuelve la clave (el `plan_id` deja de ser la credencial completa); el correo solo si el que pregunta ya lo sabe.
- Throttle de correo por destinatario y global (ventana 6 h) + respeta la cuota de MailApp (anti-bombardeo / anti-DoS del lead magnet).
- Rate-limit de `list` por correo (anti-fuerza-bruta).
- `_esc` escapa comillas; `_newId` usa `Utilities.getUuid()`.

### P1 (2026-07-25) — backend a escala + blindaje de rutas

⚠️ **Requiere re-desplegar `Code.gs` en Apps Script** (ver Despliegue). Hasta que eso pase, el front nuevo sigue funcionando contra el backend viejo.

- **Lecturas quirúrgicas**: ninguna ruta lee ya `geom_json` para buscar. `_meta()` trae solo las columnas 1-10 y `_rowByPlanId()` usa `createTextFinder().matchEntireCell(true)` acotado a la columna `plan_id`. El blob se lee de **una celda**, solo al abrir un plano. (Antes cada request arrastraba hasta 200 KB por fila: el techo real eran ~1.000-2.000 filas.)
- **El lock solo envuelve la escritura.** El correo y las validaciones salieron fuera.
- **`MAX_GEOM_BYTES` 200000 → 45000** en backend **y** cliente. Sheets no admite más de ~50.000 caracteres por celda: un plano grande pasaba la validación, reventaba al escribir y dejaba al cliente en reintento infinito. Ahora el cliente ni lo manda y avisa con todas sus letras, **sin reintentar**.
- **Rate-limit en todas las rutas con credenciales**: `plan` 30/h por id, `doPost` 30/h por correo, `list` 40/h. Claves de `CacheService` **siempre hasheadas** (MD5 base64, 24 chars) para no pasar de 250.
- **`_rateOk` y `_canEmail` son fail-closed.** Compromiso consciente: si `CacheService` cae, se rechaza en vez de dejar la puerta abierta. Es seguro para el lead porque el front muestra la clave en pantalla cuando el correo no sale.
- **Errores opacos**: el cliente recibe `error_interno`; el detalle va a `console.error` (Apps Script → Ejecuciones).
- **Límites**: correo ≤120, clave 6-40. El mínimo de 6 aplica **solo a cuentas nuevas** — una cuenta vieja con clave corta sigue entrando (compatibilidad sagrada, probada).
- **Mantenimiento**: `podarHistorial()` (20 versiones por plano, borra >90 días, sin leer el blob) y `healthPing()` (avisa por correo si la hoja deja de responder, máx. 1 aviso/6 h). **Los 2 triggers se crean a mano una vez** — instrucciones en la cabecera de `Code.gs`.

### P2 (2026-07-25) — correo desarmado + la clave deja de estar en claro

⚠️ **Requiere re-desplegar `Code.gs`.** El front ya está preparado para los dos backends (ver "negociación" abajo).

**Correo (era un cañón apuntando a cualquier buzón):** antes bastaba un POST con `correo=víctima` y `clave="lo que sea"` para que Apps Script mandara un correo con el diseño de Aurum y el texto del atacante donde va la clave. Ahora:
- Solo se manda en el **primer** guardado (`isNew`). La rama `body.sendEmail` **se eliminó**: el front nunca la usaba y era un reenvío gratis a cualquier destinatario.
- La clave debe cumplir `/^[A-Za-z0-9 ._-]{6,32}$/` para salir en el correo. Una clave rara no impide guardar, solo el envío.
- El plano debe tener contenido real (≥4 muros y ≥2 vanos/muebles): un terreno vacío ya no dispara correo.
- El nombre se filtra antes de entrar a la plantilla. Topes bajados a **40/día y 2 por destinatario**.
- Si existe el alias del dominio se manda con `GmailApp` desde `direccion@aurumarquitectos.com` (mejor entregabilidad); si no, cae solo a `MailApp`. Los pasos de SPF/DKIM/DMARC están comentados en `_sendPlanEmail`.
- Ningún lead se queda sin su clave: cuando el correo no sale, la pantalla de éxito la muestra igual.

**Clave hasheada con migración transparente:** columna nueva `clave_hash` (se crea sola, **antes** de `geom_json` para no romper la lectura quirúrgica). Hash = `SHA-256(correo + '|' + clave + '|' + SALT)`, con el SALT en `PropertiesService`, creado una vez y **nunca** cambiado. Al entrar una cuenta vieja se compara contra el texto plano, se escribe el hash y **se vacía la celda de la clave**. Cubre las 3 rutas (guardar, abrir por id, listar). La matriz completa está probada en `pruebas/backend.js`.

> 🚨 **Una vez desplegado, NO se puede volver al `Code.gs` anterior.** El backend viejo solo sabe comparar texto plano y las filas ya migradas lo tienen vacío: sus dueños quedarían fuera. Si algo sale mal, se corrige hacia adelante.

**Higiene de sesión (`crokiss-cloud.js`):**
- La clave sale de `localStorage` y pasa a **`sessionStorage`**: muere al cerrar el navegador. En `localStorage` queda solo lo no sensible (`planId`, `correo`, `planName`, `ts`) y **caduca a los 30 días** sin uso (ventana móvil).
- Consecuencia buscada: al volver en otra sesión hay que reescribir la clave para reanudar el sync. **El plano local nunca se pierde** — solo el sync se pausa, y el pill lo dice.
- El modal de guardar **ya no precarga la clave** (solo el correo). Botón **⎋ Cerrar sesión**, visible solo con sesión activa.
- Credenciales por **POST**, no en la query string (donde quedaban en el historial y en los logs).

**Negociación de despliegue (no estaba en el plan, pero es indispensable):** el front se publica solo con el push, el `Code.gs` no. Si el front nuevo exigiera el backend nuevo, "Abrir con clave" se rompería para todos hasta el re-despliegue. Por eso `postCreds()` intenta la ruta POST y, si el backend responde `plano_invalido` (que es lo que contesta el backend viejo al no encontrar un `geom`), **cae sola a la ruta GET de siempre**. Funciona con los dos backends y se actualiza sola cuando pegues el `Code.gs`.

### P3 (2026-07-25) — física táctil honesta

Solo front: **no requiere re-desplegar nada del backend.**

- **Manijas de tamaño constante en pantalla.** `K = viewBox.width / svg.clientWidth` se recalcula en cada repintado (y al redimensionar); radios, plumas y zonas tocables se multiplican por K. Cada manija lleva además un círculo invisible de 22 px de radio → **44 px de diámetro real**. Antes eran de radio fijo en unidades de usuario: en un iPhone con el terreno ajustado quedaban en ~4 px.
- **Los vanos viven en su muro.** Campo aditivo `wallId` en los vanos nuevos (los viejos se siguen deduciendo por orientación + coordenada fija). Mover un muro —arrastrando el cuerpo **o con las flechas**— se lleva sus ventanas, puertas y corredizas. Al arrastrar un vano o acortar el muro, `clampVano()` lo mantiene dentro. Y **borrar un muro se lleva sus vanos** (se había perdido en la reescritura: quedaban agujeros flotando).
- **Duplicar y copiar/pegar.** `ed.duplicateSel()`, botón **⧉ Duplicar** junto a ✕ Borrar y `Ctrl/⌘+D`. `Ctrl/⌘+C` y `Ctrl/⌘+V` usan un búfer **interno**: no se toca el portapapeles del sistema. Un vano duplicado se queda en su mismo muro.
- **Historia honesta.** `onDown` ya no empuja historia: guarda un candidato y `confirmaHistoria()` lo confirma en el primer movimiento real o al alternar un block. Seleccionar cinco veces ya no llena el Deshacer de estados idénticos.
- **Pinch limpio.** Si el segundo dedo llega a media arrastre, `cancelaDrag()` devuelve el elemento (y sus vanos) a donde estaba y descarta la historia. Antes quedaba movido un paso que nadie pidió.
- **Escalar mueble con ancla:** la esquina opuesta se queda clavada; el centro se recalcula. Antes crecía hacia los dos lados.
- **Export limpio:** `exportPNG` y la impresión (`beforeprint`/`afterprint`) deseleccionan antes de clonar y restauran después. La selección terracota ya no sale en lo que el usuario manda por WhatsApp.
- **Barra móvil:** en ≤640 px los grupos y el `.mas-wrap` pasan a `display:contents` para que los botones empaqueten de verdad (el `.spacer` con `flex:1` era el que forzaba saltos de fila), etiquetas largas ocultas, `touch-action:manipulation`, y menú propio **⋯ Más** con zoom/Avanzado/PNG/Rehacer/Fachadas/Abrir/Nuevo/Respaldo/Importar/Copiar/Imprimir. Medido en 390 px: **de 246 px y 6 filas a 97 px y 2 filas** (12% de la pantalla). La paleta de muebles entra desde abajo como hoja (45 vh) en vez de tapar el costado. En escritorio todo sigue en línea, en las mismas 3 filas de siempre.

### P4 (2026-07-25) — embudo medido + fugas de conversión

⚠️ **Requiere re-desplegar `Code.gs`** para que la pestaña Eventos se llene.

**La analítica es la propia hoja.** Cero Google Analytics, cero cookies de terceros (decisión explícita).

- `mode:'event'` en `doPost` → pestaña **Eventos** (`ts, client_id, evento, extra`, se crea sola). **Sin `LockService` y sin leer la hoja de planos**: medir jamás debe estorbarle a alguien que está guardando. Acepta lotes de hasta 20. La ruta va **antes** de validar correo/clave, porque un evento es anónimo. Rate-limit 120/h por `client_id`, fail-closed.
- `track(evento, extra, unaVez)` en el cliente: encola en `localStorage` (`ck_events_v1`, tope 100), sube por lotes cada 30 s y manda lo pendiente con `sendBeacon` al cerrar. **Best-effort**: nunca bloquea la UI, no reintenta con backoff, y si falla se queda en cola. Ante cualquier conflicto entre medir y guardar el plano, **gana el plano**.
- Instrumentado: `terreno_creado`, `primer_elemento` (una vez por sesión), `nudge_visto`, `modal_guardar_abierto`, `guardado_ok`, `guardado_error` (extra = motivo), `cta_contacto_click`, `compartir_png`. Y `volvio_por_correo`, que solo el servidor puede ver (se registra en `action=plan` cuando llega sin credenciales).

**Fugas de conversión cerradas:**
1. **CTA a WhatsApp** (`CONFIG.WHATSAPP` en `crokiss-cloud.js` y en `Code.gs`). ⚠️ **Falta que Alejandro ponga el número**: hoy dice `52XXXXXXXXXX`. Mientras tenga las X, `contactURL()` cae solo al correo de siempre — nunca queda un enlace roto.
2. **Clave autosugerida** tipo `mi-casa-347`, editable, con la nota "Te sugerimos una — puedes cambiarla". Cumple el formato que P2 exige para que la clave pueda salir en el correo. Reabrir el modal propone una nueva y **nunca** arrastra lo tecleado antes.
3. **Retorno en un paso**: al abrir con `?open=ID`, si ya conocíamos el correo en ese navegador se conserva para precargarlo, y el aviso ahora invita explícitamente: *"Escribe tu clave para seguir guardando en la nube"*.

**Cómo leer el embudo** (pestaña Eventos → Insertar → Tabla dinámica): filas = `evento`, valores = COUNTA de `client_id` (**resumir por → Recuento único**). El orden natural del embudo es `terreno_creado` → `primer_elemento` → `nudge_visto` → `modal_guardar_abierto` → `guardado_ok`. La caída más grande entre dos pasos consecutivos es el cuello. `guardado_error` agrupado por `extra` dice **por qué** se cae la gente.

### P5 (2026-07-25) — alma artesanal I

Solo front: **no requiere re-desplegar nada.**

- **Cotas editables.** Tocar la cota de un muro seleccionado abre un input flotante ahí mismo (terracota, tipografía de CroKiss). Enter aplica: **p1 se queda quieto y p2 se recorre** sobre el mismo eje, con snap; Esc cancela. Sus vanos se re-clampan con la lógica de P3. Igual para el **ancho** de ventana/corrediza/puerta seleccionada, que **recrece centrado** como el botón "+ ancho".
- **Herramienta "+ Habitación".** Arrastras un rectángulo con trazo punteado (y su medida viva al centro) y al soltar salen sus **4 muros interiores + la etiqueta**, que pide nombre con el mini-modal. Menos de 1 × 1 m se descarta con un aviso amable. El geom **no gana ningún concepto nuevo**: son muros y etiqueta normales, así que lámina, fachadas y resumen la entienden sin tocar nada.
- **Cero `prompt()` / `confirm()`.** Mini-modal propio de etiquetas con 7 chips de un tap (Recámara · Cocina · Baño · Sala · Comedor · Patio · Cochera) + campo libre; se usa al crear etiqueta, al nombrar habitación y al **doble-tocar** una etiqueta existente. "✦ Nuevo" tiene su propio modal con la voz de CroKiss. Verificado por prueba, ignorando comentarios.
- **Paleta**: se cierra sola al elegir mueble (dejarla abierta tapaba justo donde ibas a tocar).
- **Primeros 10 segundos:** (a) **mini-vista del lote** en el modal de terreno, que se redibuja al teclear y muestra la superficie; (b) **nota de lápiz dentro del lienzo** ("Toca + Muro y arrastra para dividir tu casa") — es un elemento del render, no un div, y deja de dibujarse en cuanto el usuario traza algo suyo. Va **cerca del borde superior, no en el centro geométrico**: en un terreno de 20 m de fondo el centro cae fuera de la pantalla y no se veía; (c) **pulso suave** en la herramienta activa mientras espera; (d) `navigator.vibrate(8)` al caer en la retícula, con guard de existencia.
- **Micro-entradas** de 170-180 ms **solo** en modales, nudge, éxito y toast, con `prefers-reduced-motion`. **Dentro del SVG no se anima nada**: el lienzo es papel.

## Pendiente (backend, para segunda ronda — NO shippeado por riesgo)

- **Hasheo de la clave**: hoy se guarda/transmite en claro. ⚠️ **Ya se implementó una vez** (columnas `clave_hash`+`salt`, SHA-256 con `Utilities.computeDigest`, fallback y migración) en el commit **`ec6d029`**, y `975b699` lo revirtió por accidente al subir un `Code.gs` viejo. **No lo reescribas desde cero:** parte de `git show ec6d029:Code.gs` y fusiónalo sobre el `Code.gs` actual. Sigue pendiente probarlo con una cuenta de prueba antes de activar: hacerlo mal bloquea a los leads que regresan.
- Poda del Historial (crece sin tope) e índice `plan_id→fila` para evitar el escaneo lineal a escala.
- Respaldo diario de la hoja + alerta al acercarse a la cuota de correo.

## Stack

Frontend estático HTML/CSS/JS puro + SVG (sin framework, sin build) en GitHub Pages. Backend: Google Apps Script (Web App `/exec`). BD: Google Sheets. Fuente Saira Semi Condensed, acento `#c75b39`. CORS por POST `text/plain` (sin preflight) + `LockService`.

## Archivos

| Archivo | Rol |
|---|---|
| `index.html` | Editor (barra Cliente/Avanzado, lienzo, modales, zoom/pan, campos de mueble, PNG/Etiqueta/Rehacer); carga scripts y llama `CroKiss.boot(ed)` |
| `crokiss-cloud.js` | Adaptador de nube: offline-first, sync con backoff, sendBeacon, identidad correo+clave, nudge, pantalla de éxito. Contiene `CONFIG.ENDPOINT` y `CONFIG.CONTACT_URL` |
| `Code.gs` | Backend endurecido: doGet list/plan/ping, doPost save/sync, correo con throttle, antiinyección, anti-abuso. Contiene `CONFIG.SITE_BASE` |
| `plan-editor.js` | Motor: geometría, render SVG, interacción, snap, undo/redo, zoom/pinch/pan, muebles, etiquetas, PNG. Expone `getGeom()`/`loadGeom()` y los hooks de lámina/fachadas (`setSheet`, `updateElev`, `updateVanoZ`, `getWallCm`) |
| `plan-sheet.js` | **Lámina de 2 páginas** (pág. 1 planta a mejor escala; pág. 2 las 4 fachadas en rejilla a escala común) + cajetín Aurum; overlay `#ck_lamina` y `window.print()` con salto de página. API: `open(ed)`, `_buildPages`, `_buildSheet`, `setElevProvider` |
| `plan-elev.js` | **Fachadas de las 4 orientaciones**: `facade(geom, dir, opts?)` con dir S/N/E/O, envolvente exterior, fusión de muros casi-colineales, recorte al terreno; devuelve `stats` y `avisos` |
| `plan-elev-editor.js` | **Editor de fachadas** (`PlanElevEditor.open(ed)`, overlay `#ck_elevedit`): pestañas por orientación, alturas del proyecto (`ed.updateElev`) y override por vano (`ed.updateVanoZ`) |
| `plan-render.js` | (Proyecto Marbel, sin cambios) geometría de muestra |
| `plan-furniture.js` | Catálogo `PlanFurniture.CATALOG` y `PlanFurniture.draw()` (ampliado) |
| `pruebas/harness.js` | Harness jsdom (solo pruebas, no se despliega) |

## Validación

**Antes de cada entrega:** `node --check` a los 7 `.js` + el harness jsdom (`pruebas/harness.js`, 62 pruebas) + verificación EN PRODUCCIÓN con cache-bust (`?cb=<timestamp>`).

jsdom es dependencia **solo de pruebas** (la app sigue sin build ni dependencias; `node_modules/` y `package.json` están en `.gitignore`):

```bash
mkdir -p /tmp/ck && cd /tmp/ck && npm init -y && npm i jsdom
cd ~/crokiss && NODE_PATH=/tmp/ck/node_modules node pruebas/harness.js
```

Cubre: los 8 scripts cargan, cero errores de JS al arrancar, la super mejora intacta (`advToggle`, `pngBtn`, `redoBtn`, `labelBtn`, zoom/pan), los hooks del motor, persistencia de `wallCm`/`elev`, y que los botones de **Lámina** y **Fachadas** existen y **su handler realmente corre** (construyen `#ck_lamina` y `#ck_elevedit`). El harness bloquea la red: **jamás** debe tocar el `/exec` de producción (cada guardado es un lead real).

## URLs y datos

- Repo: https://github.com/alexpueblag/crokiss
- Sitio: https://alexpueblag.github.io/crokiss/
- `/exec`: https://script.google.com/macros/s/AKfycbxFtuOvgTIkZehUqcJUA7rWpULGncFLDRZEEPAKLhLTr73dP7v1QdcE73g7yrGdcZyHsg/exec
- Hoja: "CroKiss — Planos" (pestañas Planos e Historial)
- Esquema Planos: `ts, plan_id, client_id, nombre, correo, clave, plan_name, version, marketing, source, geom_json`
- Esquema Historial: `ts, plan_id, plan_name, correo, version, geom_json`

## Despliegue

- **Front:** subir archivos al repo → Pages ~1 min → recargar con Ctrl+Shift+R.
- **Backend:** pegar `Code.gs` en Apps Script → Implementar → Gestionar implementaciones → editar (lápiz) → **Versión nueva**. NUNCA crear implementación nueva (cambiaría la URL `/exec`). Esta ronda SÍ requiere re-desplegar el backend para activar el endurecimiento de seguridad.

## Decisiones importantes (no revertir sin razón)

1. Offline-first: NO reemplazar `save()` por fetch; detección por polling para no tocar el motor.
2. Zoom por viewBox, no por transform (`clientToM` usa `getScreenCTM`).
3. Identidad correo+clave = cuenta con varios proyectos; guardar por `plan_id`.
4. Historial solo en guardado explícito; Planos en filas.
5. Sin secretos en el front (endpoint público a propósito); seguridad reforzada del lado del backend.
6. Terreno = 4 muros perimetrales vía `loadGeom()`.
7. **Nunca desplegar desde zips ni copias descargadas — siempre `git pull` → editar → `commit` → `push`.** Ya costó tres regresiones (ver Estado actual).
8. La lámina es el único camino al entregable: `plan-sheet.js` no reconstruye `Planta Arquitectonica.html` (eliminado del flujo, su botón estaba roto).
9. Espesor y alturas viven DENTRO del `geom` (`geom.wallCm`, `geom.elev`), no en variables sueltas: así viajan a la nube, sobreviven a deshacer/rehacer y la lámina/fachadas leen la verdad del proyecto.

## Preferencias de trabajo

- Entorno: Chromebook (Crostini); prueba local con `python3 -m http.server 8000`.
- Trabajar en español, con pasos de ejecución detallados.
- Entregar archivos completos, no parches.
- Integridad de datos sobre presentación.
