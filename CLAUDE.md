# CroKiss — editor de planos 2D gratis que convierte cada croquis guardado en un lead

Lee este archivo completo antes de tocar nada.

> Reordenado el **2026-09-04**: se conservó el contenido útil del anterior; lo vencido va ~~tachado~~.

## Qué es

Editor de planos 2D (muros, ventanas, puertas, corredizas, muebles, etiquetas) que arranca pidiendo
el tamaño del terreno. Público, gratis, sin registro. Es el **imán de prospectos** de Aurum / Yo
Desarrollo: al guardar, la persona deja correo + clave y recibe su plano por correo con enlace para
volver. **Cada guardado = un lead**; la métrica de uso son los correos distintos.

- Lo usa: cualquiera que llegue de una publicación. Lo opera: Alejandro (dirección de Aurum).
- **Dirección viva:** `https://yodesarrollomx.github.io/crokiss/` — **HTTP 200** (curl 2026-09-04).
  Para publicaciones se usa `?guia=1` (fuerza la guía). `aviso-privacidad.html`: **HTTP 200**.
- Casa vieja `alexpueblag.github.io/crokiss/` — **HTTP 200**, pero es el **cascarón** «Se mudó», que
  reenvía **por JS, no por 30x** (curl 2026-09-04; memoria `rename-github-yodesarrollomx`, 7.5); trae
  el `og:image` congelado para que las ligas viejas de WhatsApp/Facebook no salgan en blanco.
- ~~`tableros.yodesarrollo.mx/crokiss/`~~ **NO EXISTE todavía**: curl 2026-09-04 falla con exit 6 (el
  host no resuelve); el dominio propio sigue bloqueado en el DNS.
- Backend `/exec` **vivo**: `?action=ping` → `{"ok":true,"pong":true}` (curl 2026-09-04). **Sin portero
  ni login** (`grep -rn portero` no da nada): los candados están en el backend, no en la puerta.

## Reglas INVIOLABLES

1. **Nunca desplegar desde zips ni copias descargadas**: `git pull` → editar el árbol → `commit` →
   `push`. `dcbd102` y `975b699` se armaron desde zips y sepultaron trabajo ya hecho **tres veces**
   (scripts de la lámina, hooks del motor, y el hasheo SHA-256 de `ec6d029` revertido byte a byte).
2. **El repo NO es la fuente de verdad de lo que corre en Apps Script.** Antes de tocar `Code.gs`,
   pide el pegado en el editor y compáralo: el 2026-07-26 el repo decía "pendiente" un hasheo que
   llevaba semanas vivo, y desplegarlo habría dejado fuera **para siempre** a los usuarios ya
   migrados (memoria `backend-vivo-no-es-el-repo`).
3. **Nunca crear implementación nueva en Apps Script**: se edita la existente y se elige "Versión
   nueva". Una nueva cambia la URL `/exec` y rompe el editor y **todos los enlaces ya enviados**.
4. **Nunca hacer POST al `/exec` de producción para probar**: cada guardado crea un lead real. Se
   levanta una copia con `ENDPOINT` a un sink local; interceptar `fetch` desde la consola **no sirve**
   (la recarga se lleva la intercepción).
5. **Una vez desplegado el hasheo no hay vuelta atrás**: las filas migradas tienen `clave` vacía y el
   texto plano no existe en ningún lado. Si algo sale mal, se corrige hacia adelante.
6. **Ningún lead se queda sin su clave**: si el correo no sale, la pantalla de éxito la muestra. Por
   eso `_rateOk`/`_canEmail` pueden ser fail-closed sin dejar a nadie tirado.
7. **Ante conflicto entre medir y guardar, gana el plano**: `track` es best-effort, sin lock y sin
   leer la hoja de planos.
8. **Cero `prompt()`/`confirm()`/`alert()`**: congelan la pestaña y a cualquier revisor automático
   (memoria `rename-github-yodesarrollomx`, auditoría 2-sep).
9. **Sin frameworks ni build.** HTML/CSS/JS puro + SVG; jsdom es dependencia solo de pruebas
   (`node_modules/`, `package.json` en `.gitignore`).
10. **Subir `CK_VERSION` en cada despliegue del front** (`index.html:825`; hoy `2026-07-26`).

## Archivos

| Archivo | Qué hace |
|---|---|
| `index.html` | El editor completo: barra Cliente/⚙ Avanzado, lienzo SVG, modales, guía de bienvenida (12 herramientas dibujadas en SVG+CSS), `CK_VERSION`. Carga los 7 scripts y llama `CroKiss.boot(ed)` |
| `plan-editor.js` | Motor: geometría, render, snap, undo/redo, pinch/pan, muebles, etiquetas, cotas editables, PNG. Expone `getGeom()`/`loadGeom()` y los hooks `setSheet`, `updateElev`, `updateVanoZ`, `getWallCm`, `setSoloLectura` |
| `crokiss-cloud.js` | Nube: offline-first, sync con backoff, `sendBeacon`, identidad correo+clave, nudge de guardado, pantalla de éxito, embudo `track()`. Aquí viven `CONFIG.ENDPOINT` (línea 14), `CONFIG.WHATSAPP` (27) y `CONFIG.CONTACT_URL` (29) |
| `Code.gs` | Backend Apps Script: `doGet` list/plan/ping, `doPost` save/sync/event/borrar, correo con throttle, antiinyección, rate-limits. Aquí viven `CONFIG.SITE_BASE` (46) y `CONFIG.WHATSAPP` (53) |
| `plan-sheet.js` | Lámina de 2 páginas (planta + las 4 fachadas a escala común) con cajetín Aurum; overlay `#ck_lamina` + `window.print()` |
| `plan-elev.js` · `plan-elev-editor.js` | Fachadas de las 4 orientaciones (`facade(geom,dir)`, envolvente exterior, recorte al terreno) y su editor (overlay `#ck_elevedit`: alturas del proyecto y override por vano) |
| `plan-furniture.js` · `plan-render.js` | Catálogo de muebles (`PlanFurniture.CATALOG`/`.draw()`) y geometría de muestra heredada de "Proyecto Marbel" |
| `aviso-privacidad.html` | LFPDPPP: responsable, datos, finalidades, ARCO. Existe porque el dominio aurumarquitectos.com estaba con SSL roto |
| `pruebas/harness.js` · `pruebas/backend.js` · `OPERACION.md` | Pruebas jsdom y con stubs de Apps Script (no se despliegan) + el manual sin código para Alejandro |

## Arquitectura de datos

```
Persona en el navegador
   │  dibuja → geom (muros, vanos, muebles, labels, wallCm, elev) → localStorage (offline-first)
   ├─ POST {mode:'save'|'sync'|'event'|'borrar', correo, clave, geom, png, telefono, src}
   │     ↓  Apps Script Web App (/exec)
   │        https://script.google.com/macros/s/AKfycbxFtuOvgTIkZehUqcJUA7rWpULGncFLDRZEEPAKLhLTr73dP7v1QdcE73g7yrGdcZyHsg/exec
   │     ↓  Hoja "CroKiss — Planos": Planos (1 fila/proyecto) · Historial (guardado explícito;
   │        poda 20 versiones / 90 días) · Eventos (el embudo, se crea sola)
   │     ↓  Correo al lead (PNG adjunto + clave + enlace ?open=ID) + aviso interno a direccion@
   └─ GET ?action=plan&id=… → abrir por enlace  ·  ?plan=ID → vitrina de solo lectura (caduca 60 días)
```

**⚠️ El repo es ESPEJO. Lo que corre es lo pegado en el editor de Apps Script.** Un push a GitHub
publica el front en ~1 minuto; el backend **no** se mueve solo. Ver regla INVIOLABLE 2.

Esquema **Planos** vivo (`Code.gs:91-93`, `HEADERS`):
`ts, plan_id, client_id, nombre, correo, clave, plan_name, version, marketing, source, geom_json, clave_hash, salt, telefono`
- Corrección 2026-09-04: el doc anterior listaba el esquema ~~terminando en `geom_json`~~;
  `clave_hash`, `salt` y `telefono` van **después**, por eso `_meta()` lee los metadatos en dos tramos
  saltándose el blob. `_ensureHeader` agrega columnas al final sin mover nada.
- Hash vivo: `SHA-256(sal_de_la_fila + ':' + clave)` en **hex**, **sal por fila** en su columna.
  Esquema **Historial**: `ts, plan_id, plan_name, correo, version, geom_json`.
- Topes en `CONFIG` de `Code.gs`: `MAX_GEOM_BYTES 45000` (Sheets no admite ~50.000 chars/celda),
  `MAX_POR_CORREO 60`, `MAX_PLAN_ID 120/h`, `MAX_SYNC_CORREO 360/h`, `DIAS_COMPARTIR 60`.

**Leer el embudo:** Eventos → Tabla dinámica → filas `evento`, valores COUNTA de `client_id`
**resumido por Recuento único**. Orden natural: `guia_vista → terreno_creado → primer_elemento →
nudge_visto → modal_guardar_abierto → guardado_ok`. La caída más grande entre dos pasos es el cuello;
`guardado_error` agrupado por `extra` dice por qué.

## Decisiones

Autor por defecto = la cuenta que firma el commit (`alexpueblag <direccion@aurumarquitectos.com>` =
Alejandro). El porqué se conserva tal cual venía en el CLAUDE.md anterior.

- **2026-06 · Offline-first**: no reemplazar `save()` por fetch, la nube detecta por polling — para
  no tocar el motor y que nadie pierda su dibujo sin señal. **Zoom por `viewBox`, no por `transform`**
  (`clientToM` usa `getScreenCTM`), para que las coordenadas del puntero sigan siendo honestas.
  **Identidad = correo + clave** (una cuenta, varios proyectos; se guarda por `plan_id`).
- **2026-06 · Espesor y alturas viven DENTRO del `geom`** (`geom.wallCm`, `geom.elev`): viajan a la
  nube, sobreviven a deshacer/rehacer y lámina/fachadas leen la verdad del proyecto. **La lámina es
  el único camino al entregable** (`plan-sheet.js` no reconstruye `Planta Arquitectonica.html`).
- **2026-07-25 (`0d3c3e6`, rescate P0) · Reintegrar los 3 `<script>` de lámina/fachadas** sobre el
  `index.html` vivo. Porqué: los archivos estaban en el repo pero **nada los cargaba** desde `dcbd102`.
- **2026-07-25 (P1) · Lecturas quirúrgicas y lock solo alrededor de la escritura** (cada request
  arrastraba hasta 200 KB por fila: el techo real eran ~1.000–2.000 filas), y **`_rateOk`/`_canEmail`
  fail-closed** (si `CacheService` cae se rechaza en vez de dejar la puerta abierta).
- **2026-07-25 (P2, `301a6df`) · Fuera la rama `body.sendEmail`; el correo solo sale en el primer
  guardado.** Era un cañón: un POST con `correo=víctima` mandaba un correo con el diseño de Aurum y
  el texto del atacante donde va la clave.
- **2026-07-25 (P2) · La clave pasa a `sessionStorage`** (muere al cerrar el navegador; el plano
  local nunca se pierde, solo se pausa el sync y el pill lo dice) y **`postCreds()` negocia con los
  dos backends** (POST, y cae a GET si el `/exec` viejo responde `plano_invalido`).
- **2026-07-25 (P4) · La analítica es la propia hoja** (pestaña Eventos): cero Google Analytics,
  cero cookies de terceros. Decisión explícita.
- **2026-07-26 (`3a7a029`) · Alinear `Code.gs` con el esquema que YA corre en producción** (sal por
  fila, hex, columnas al final) y blindarlo con la prueba de compatibilidad de `pruebas/backend.js`.
  Porqué: ver regla INVIOLABLE 2. Es la decisión más cara del proyecto.
- **2026-07-26 (`87ef8f4`, enjambre de UX en 390 px) · Barra a 2 filas / 111 px, botones de 44 px.**
  El aviso de guardado —el CTA de captación— se salía de pantalla (x=407 en 390 px): en un teléfono
  **no había forma de tocarlo**.
- **2026-07-26 (`a032ecc`, comité de inversión) · El correo ENTREGA el plano** (PNG adjunto, tope
  2.5 s / 1.5 MB; el guardado jamás lo espera) + aviso de lead nuevo a `direccion@` + WhatsApp
  opcional del lead (columna `telefono`).
- **2026-07-26 (`958a08d`) · Guía de bienvenida** que sale sola solo en la primera visita, **nunca**
  encima de `?open=ID` ni `?plan=ID`, forzable con `?guia=1`, reabrible en ⋯ Más → ❓ Cómo funciona.
- **2026-07-26 (`09a6eb2`) · Sobrescribir exige identidad** (`plan_id`, o `reclamar_id` verificado
  contra las credenciales); sin ella **siempre se crea** y el nombre repetido pasa a «Mi proyecto (2)»
  + toast. Desde junio, reusar la clave de siempre **pisaba el croquis anterior en silencio**.
- **2026-09-01 (`87e49ef`) y 2026-09-04 (`6779c77`) · Casa canónica = `yodesarrollomx.github.io`.**
  Se movieron ligas del front y `CONFIG.SITE_BASE` de `Code.gs`. La casa vieja queda de cascarón.
- ~~**Pendiente: poner el WhatsApp** (`CONFIG.WHATSAPP` decía `52XXXXXXXXXX`).~~ **OBSOLETO desde
  2026-07-26** (`8e58c4f`): hoy es `wa.me/5216623184512` en `crokiss-cloud.js:27` **y** `Code.gs:53`.
- ~~**CK_VERSION `2026-07-25`.**~~ **OBSOLETO**: `index.html:825` dice `2026-07-26`.
- ~~**Pendiente 2ª ronda: hasheo de clave, poda del Historial, alerta de salud.**~~ **OBSOLETO desde
  2026-07-26**: los tres se hicieron en P1–P2 y están vivos en producción.

## Pendientes

| # | Qué falta | Dueño | Evidencia para darlo por cerrado |
|---|---|---|---|
| 1 | **Re-desplegar `Code.gs` con `SITE_BASE` = `yodesarrollomx.github.io/crokiss/`.** El cambio está en el repo (`6779c77`, `Code.gs:46`) pero **no se pudo pegar**: el Apps Script de CroKiss no está compartido con la cuenta que opera desde la Mac. Mientras tanto, los enlaces `?open=ID` que salen por correo apuntan a la casa vieja (el cascarón los reenvía por JS, así que funcionan, pero con un salto de más). | Alejandro: compartir el script o pasar el `scriptId` | Un correo de prueba (o el propio `_sendPlanEmail`) cuyo enlace ya diga `yodesarrollomx.github.io` |
| 2 | **Crear los 2 activadores de mantenimiento**: `podarHistorial` (diario) y `healthPing` (por horas). Hay un `instalarTriggers()` de un solo ▶ (`5fcbe18`); instrucciones en la cabecera de `Code.gs`. | Alejandro | Captura del panel de Activadores con los dos listados |
| 3 | **Respaldo semanal** `respaldoSemanal` (paso 3 de `OPERACION.md`). | Alejandro | Carpeta "CroKiss Respaldos" en Drive con al menos una copia |
| 4 | **Limpiar filas de prueba** de Planos e Historial y marcar `source='test'` en adelante. | Alejandro | Hoja sin correos de prueba en las métricas |
| 5 | **SPF/DKIM/DMARC del dominio** para que el correo salga desde `direccion@aurumarquitectos.com` (pasos comentados en `_sendPlanEmail`). Opcional. | Alejandro | Un correo recibido cuyo remitente sea el del dominio |
| 6 | **Correr el harness antes de cada entrega.** Hoy 2026-09-04 no se pudo: jsdom no está instalado en esta Mac (`/tmp/ck/node_modules` no existe); sí pasó `node --check` en los 9 `.js`. Instalar con `mkdir -p /tmp/ck && cd /tmp/ck && npm init -y && npm i jsdom`. | quien toque el código | `NODE_PATH=/tmp/ck/node_modules node pruebas/harness.js` y `.../backend.js` en verde |

## Por confirmar (no afirmar sin preguntar)

- **¿Cuántas pruebas hay hoy?** El doc anterior decía 62 en un lado y "168 backend + 309 harness" en
  otro; la memoria `crokiss-project` dice 477, y `harness.js` cambió el 2026-09-01. Correrlas y anotar.
- **¿El `Code.gs` del editor es igual al del repo?** No se pudo comparar (script no compartido).
  Pedir a Alejandro que pegue el del editor y buscar `lead_alerta_error` (marca de la versión 26-jul).
- **¿Cuántos leads lleva la hoja "CroKiss — Planos"?** No se abrió el Sheet en esta pasada.
- **¿Sigue con SSL roto aurumarquitectos.com?** Era el motivo del `aviso-privacidad.html` propio.
