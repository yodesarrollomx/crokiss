# CroKiss — "El primer beso con tu proyecto"

Editor de planos 2D embebible (muros, ventanas, puertas, corredizas, muebles, etiquetas de espacio) que parte del tamaño del terreno. Herramienta pública y gratuita embebida en el portal de Yodesarrollo; imán de prospectos para Aurum/Yodesarrollo: al guardar, el usuario deja correo + clave y recibe su plano por correo con enlace para volver. Cada guardado = un lead. Métrica de uso = correos distintos.

## Estado actual (2026-07)

Core funcional de punta a punta y publicado. En esta ronda pasó por una auditoría de 3 expertos (UX/producto, ingeniería frontend, backend/seguridad) y se implementó una "super mejora" (front desplegado; backend endurecido listo para re-desplegar).

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

## Pendiente (backend, para segunda ronda — NO shippeado por riesgo)

- **Hasheo de la clave**: hoy se guarda/transmite en claro. Recomendado AGREGAR columnas `clave_hash`+`salt` (SHA-256 con `Utilities.computeDigest`), con fallback a texto plano para no dejar fuera a usuarios existentes. No se activó en esta ronda porque cambia la autenticación y no se puede probar sin el runtime de Apps Script; hacerlo mal bloquea a los leads que regresan. Implementar y probar con una cuenta de prueba antes de activar.
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
| `plan-editor.js` | Motor: geometría, render SVG, interacción, snap, undo/redo, zoom/pinch/pan, muebles, etiquetas, PNG. Expone `getGeom()`/`loadGeom()` |
| `plan-render.js` | (Proyecto Marbel, sin cambios) geometría de muestra |
| `plan-furniture.js` | Catálogo `PlanFurniture.CATALOG` y `PlanFurniture.draw()` (ampliado) |

## Validación

Harness jsdom: 19 pruebas de motor (saneo/clamp anti-cuelgue, XSS neutralizado, undo/redo, aislamiento de historial entre proyectos, API nueva) + 16 de integración (arranque sin errores, UI Cliente/Avanzado, marketing opt-in, "Ver plano final" oculto, catálogo, boot de nube). Correr con node+jsdom antes de cada entrega.

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

## Preferencias de trabajo

- Entorno: Chromebook (Crostini); prueba local con `python3 -m http.server 8000`.
- Trabajar en español, con pasos de ejecución detallados.
- Entregar archivos completos, no parches.
- Integridad de datos sobre presentación.
