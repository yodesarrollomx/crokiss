# CroKiss — "El primer beso con tu proyecto"

Editor de planos 2D embebible (muros, ventanas, puertas, corredizas, muebles) que parte del tamaño del terreno. Herramienta pública y gratuita embebida en el portal de Yodesarrollo; imán de prospectos para Aurum/Yodesarrollo: al guardar, el usuario deja correo + clave y recibe su plano por correo con enlace para volver. Cada guardado = un lead. Métrica de uso = correos distintos.

## Estado actual (2026-06)

Core ~90%, funcional de punta a punta y publicado en producción.

**Funciona:** editor 2D completo (muros, ventanas, puertas, corredizas, muebles, muro de block con junta, refuerzos, longitudes en vivo, deshacer, copiar resumen, imprimir, respaldo/importar JSON); onboarding por terreno (siembra 4 muros perimetrales); persistencia offline-first en Google Sheets (localStorage + sync con debounce + sendBeacon al cerrar); identidad correo+clave = cuenta con varios proyectos; "Abrir con clave" con selector (nombre · versión · hora); correo branded con clave + enlace `?open=ID`; Historial solo en guardado explícito; anti-abuso (honeypot, tope 200 KB, tope 60/correo); zoom (botones +/−/Ajustar, Ctrl/⌘+rueda hacia el cursor) y pan (✋ Mover o Espacio+arrastrar), solo vista; edición numérica de Ancho/Largo de muebles (cm).

**Falta (opcional):** "Ver versiones" (rollback desde Historial); planta final compartible `?plan=ID`; galería "Mis planos" con miniaturas.

**Bugs conocidos:**
- "Ver plano final →" (Planta Arquitectonica.html) roto: referencia `design-canvas.jsx` y `tweaks-panel.jsx` que no venían en el zip original (el editor NO depende de ellos).
- Filas de prueba mezcladas en la hoja (borrar a mano).
- Drift menor del aspecto del viewBox si el dibujo crece con zoom (se arregla con "Ajustar").
- Los correos pueden caer en spam la 1ª vez.

## Stack

Frontend estático HTML/CSS/JS puro + SVG (sin framework, sin build) en GitHub Pages. Backend: Google Apps Script (Web App `/exec`). BD: Google Sheets. Fuente Saira Semi Condensed, acento `#c75b39`. CORS por POST `text/plain` (sin preflight) + `LockService`.

## Archivos

| Archivo | Rol |
|---|---|
| `index.html` | Editor (barra, lienzo, modales terreno/guardar/abrir/selector, zoom/pan, campos de mueble); carga scripts y llama `CroKiss.boot(ed)` |
| `crokiss-cloud.js` | Adaptador de nube: offline-first, sync con debounce, sendBeacon, identidad correo+clave, modales y selector. Contiene `CONFIG.ENDPOINT` (`/exec`) |
| `Code.gs` | Backend: doGet `list`/`plan`/`ping`, doPost `save`/`sync`, correo, anti-abuso, hojas Planos+Historial. Contiene `CONFIG.SITE_BASE` |
| `plan-editor.js` | Motor: geometría, render SVG, interacción, snap, undo, zoom/pan, edición de muebles. Expone `getGeom()`/`loadGeom()` |
| `plan-render.js` | (Proyecto Marbel, sin cambios) geometría de muestra `PlanRender.GEOMETRY` |
| `plan-furniture.js` | (Proyecto Marbel, sin cambios) catálogo `PlanFurniture.CATALOG` y `PlanFurniture.draw()` |

Los 6 archivos viajan juntos. Pendiente: faltan `design-canvas.jsx` y `tweaks-panel.jsx` (solo para la planta final).

## Arquitectura

El motor guarda `geom` (~2 KB) en localStorage `marbel_editor_geom_v1` en cada cambio. `crokiss-cloud.js` detecta cambios por polling de `getGeom()` (1.5 s) y sube a Sheets con debounce 2.2 s solo si hay proyecto reclamado. Identidad en `crokiss_identity_v1`. El backend hace upsert por `plan_id` en Planos (1 fila/proyecto) y añade a Historial solo al guardar explícito.

## Decisiones importantes (no revertir sin razón)

1. Offline-first: NO reemplazar `save()` por fetch (saturaría Apps Script en cada arrastre); detección por polling para no tocar el motor.
2. Zoom por viewBox, no por transform: `clientToM` usa `getScreenCTM`, los clics se recalculan solos.
3. Zoom solo con Ctrl/⌘+rueda (scroll normal intacto; captura pinch); pan con botón o Espacio; topado al 100% del terreno con clamp.
4. Identidad correo+clave = cuenta con varios proyectos; guardar por `plan_id` (no se pisan); selector al abrir.
5. Historial solo en guardado explícito; Planos en filas, no columnas.
6. Sin secretos en el front (endpoint público a propósito); anti-abuso ligero.
7. Terreno = 4 muros perimetrales vía `loadGeom()` (sin tocar `defaultGeom`); guarda `geom.lot` como metadato.

## URLs y datos

- Repo: https://github.com/alexpueblag/crokiss
- Sitio: https://alexpueblag.github.io/crokiss/
- `/exec`: https://script.google.com/macros/s/AKfycbxFtuOvgTIkZehUqcJUA7rWpULGncFLDRZEEPAKLhLTr73dP7v1QdcE73g7yrGdcZyHsg/exec
- Hoja: "CroKiss — Planos" (pestañas Planos e Historial)
- Esquema Planos: `ts, plan_id, client_id, nombre, correo, clave, plan_name, version, marketing, source, geom_json`
- Esquema Historial: `ts, plan_id, plan_name, correo, version, geom_json`

## Despliegue

- **Front:** subir archivos al repo → Pages ~1 min → recargar con Ctrl+Shift+R.
- **Backend:** pegar Code.gs → Implementar → Gestionar implementaciones → editar (lápiz) → Versión nueva. NUNCA crear implementación nueva (cambiaría la URL `/exec`).

## Siguiente paso

Subir a GitHub `index.html` + `plan-editor.js` (los 2 modificados), esperar ~1 min, recargar con Ctrl+Shift+R (sin cambio de Apps Script); probar zoom/pan y edición de muebles en producción. Después, a elección: "Ver versiones" (rollback), planta final `?plan=ID`, o galería "Mis planos".

## Preferencias de trabajo

- Entorno: Chromebook (Crostini); prueba local con `python3 -m http.server 8000`.
- Trabajar en español, con pasos de ejecución detallados.
- Entregar archivos completos, no parches.
- Integridad de datos sobre presentación.
