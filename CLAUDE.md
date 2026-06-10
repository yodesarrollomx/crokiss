# CroKiss — "El primer beso con tu proyecto"

Editor de planos 2D embebible (muros, ventanas, puertas, corredizas, muebles) que parte del tamaño del terreno. Herramienta pública y gratuita embebida en el portal de Yodesarrollo; imán de prospectos para Aurum/Yodesarrollo: al guardar, el usuario deja correo + clave y recibe su plano por correo con enlace para volver. Cada guardado = un lead. Métrica de uso = correos distintos.

> Esta documentación describe el código tal como ESTÁ. Si algo de aquí no
> coincide con el código, manda el código y corrige este archivo.

## Estado actual (2026-06-09)

Ola grande de arreglos y features aplicada en local — **PENDIENTE DE DESPLEGAR** (front a GitHub Pages + Code.gs a Apps Script). Producción aún corre la versión anterior con los bugs descritos en `REVISION-2026-06-09.md`.

**Funciona (tras esta ola):** editor 2D completo (muros, ventanas, puertas, corredizas, muebles, muro de block con junta, refuerzos, longitudes en vivo, deshacer sin estados duplicados y con Ctrl/⌘+Z, copiar resumen con totales, imprimir, respaldo/importar JSON); onboarding por terreno (siembra 4 muros perimetrales, modal cancelable con Esc); persistencia offline-first en Google Sheets (localStorage + sync con debounce 8 s + sendBeacon al cerrar); identidad correo+clave; "Abrir con clave"; abrir por enlace `?open=ID` SIN exponer la clave (barra pide la clave para reactivar el sync); correo branded con clave + enlace; aviso con la clave en pantalla si el correo falla; zoom (botones, Ctrl/⌘+rueda) y pan; edición numérica de muebles (cm); **Lámina / PDF de DOS páginas** (pág. 1 solo planta a mejor escala; pág. 2 las 4 fachadas en rejilla 2×2 a la misma escala; cada hoja en su página física al imprimir); **fachadas automáticas de las 4 orientaciones (F4)** con líneas de nivel NPT y pretil configurable; **editor de fachadas** (botón "Fachadas": pestañas S/N/Oriente/Poniente, alturas del proyecto y override por vano con clic, todo entra al deshacer); banda persistente en modo colocación con Esc; al borrar un muro se van sus vanos; espesor de muro y alturas persistidos en el geom; barra en dos niveles con iconos SVG y CTA en acento.

**Falta (por prioridad):** desplegar esta ola; "Ver versiones" (rollback desde Historial); planta compartible `?plan=ID` solo lectura; selector "Mis planos" (`action=list` NO existe en el backend; el modal `ck_modal_select` del HTML es huérfano a propósito); etiquetas de ambientes con áreas; métricas de embudo; registro de 1 campo; cubierta inclinada en fachadas.

**Bugs/limitaciones conocidos:**
- Fachadas: muros oblicuos se omiten; retranqueos sin sombras (en gris); plantas en L complejas pueden mostrar costuras simplificadas.
- Drift menor del aspecto del viewBox si el dibujo crece con zoom (se arregla con "Ajustar").
- Los correos pueden caer en spam la 1ª vez.
- Filas de prueba viejas mezcladas en la hoja (limpiar a mano; usar `source='test'` para pruebas futuras).
- El upsert sigue siendo por `(correo, clave)`: reutilizar la misma clave en un "proyecto nuevo" sobrescribe el anterior. Migrar a upsert por `plan_id` está en el plan (P2-4 del informe).

## Stack

Frontend estático HTML/CSS/JS puro + SVG (sin framework, sin build) en GitHub Pages. Backend: Google Apps Script (Web App `/exec`). BD: Google Sheets. Fuente Saira Semi Condensed, acento `#c75b39`. CORS por POST `text/plain` (sin preflight) + `LockService` (solo alrededor de la hoja; correo y validaciones fuera del lock).

## Archivos

| Archivo | Rol |
|---|---|
| `index.html` | UI: barra en 2 niveles (Dibujar+Proyecto / ajustes+Vista), iconos SVG inline, lienzo, modales, CSS responsive básico; carga scripts y llama `CroKiss.boot(ed)` |
| `crokiss-cloud.js` | Adaptador de nube: offline-first, sync debounce 8 s, sendBeacon, identidad, modales, mapa de errores→mensajes, barra de clave para `?open=ID`, aviso de clave si el correo falla. `CONFIG.ENDPOINT` |
| `Code.gs` | Backend: doGet `ping`/`plan` (sin clave)/`open`, doPost `save`/`sync`, correo (cuota verificada, fuera del lock), búsquedas por columnas sin leer el blob, Historial solo en `save`, `respaldoSemanal()`. Cabecera = pasos de despliegue |
| `plan-editor.js` | Motor: geometría, render SVG (paleta: muros `#2b2b2b`, muebles `#9a8f85`, cotas `#c75b39`), interacción, snap, undo dedupe, zoom/pan, banda de colocación, `geom.wallCm`/`geom.elev` persistidos. Expone `getGeom()`/`loadGeom()` |
| `plan-sheet.js` | Lámina de 2 páginas: pág. 1 planta (cota general = terreno, dibujo con clip al terreno), pág. 2 fachadas SIN textos del motor con layout adaptativo (2×2 vs filas a lo ancho: gana la menor escala), etiquetas pegadas al dibujo y niveles legibles en mm; cajetín "LÁMINA n DE m"; overlay apilado + `window.print()` con page-break. API: `open`, `_buildPages`, `_buildSheet`, `setElevProvider` |
| `plan-elev.js` | Fachadas F4+saneamiento: `facade(geom, dir, opts?)` con dir S/N/E/O (espejado: S s=x · N s=maxX−x · E s=maxY−y · O s=y) y `opts={textos, resaltar:{kind,id}}` (resaltar = halo + cotas vivas); fusión de muros casi-colineales (DTOL 0.20 m), recorte al dominio de muros perpendiculares y al terreno, clip de vanos al tramo visible; devuelve además `stats` (m² muro/vanos, % huecos) y `avisos` de modelo. Dibujo: silueta única, plumas jerárquicas, marcos/repisones/cristal con gradiente (id `ckg{dir}`), puertas con tablero, terreno hachurado, niveles raya-punto fuera del volumen, cota vertical de alturas, overrides marcados con triángulo acento |
| `plan-elev-editor.js` | Editor de fachadas (`PlanElevEditor.open(ed)`, botón `btnFachadas`): pestañas por orientación, panel de alturas del proyecto (`ed.updateElev`), clic en vano → alturas propias (`ed.updateVanoZ`, null = quitar override), Esc en captura |
| `plan-render.js` / `plan-furniture.js` | (Heredados de Marbel, sin cambios) geometría de muestra y catálogo/dibujo de muebles |

## Contratos (front ↔ backend)

- Códigos de error: `no_existe`, `clave_incorrecta`, `muy_grande`, `clave_larga`, `tope_alcanzado`, `spam` (cloud mantiene compatibilidad con los códigos viejos).
- `action=plan` (`?open=ID`) devuelve `{ok, nombre, correo, plan_name, version, plan_id, geom}` — **nunca la clave**. El front edita en local y pide la clave en una barra para reactivar el sync (la clave viene en el mismo correo del enlace).
- Límite del plano: **45000 bytes** en ambos lados. Clave ≤ 40 caracteres.
- Alturas: `geom.elev = {hMuro:2.40, antepecho:0.90, dintel:2.10, cubierta:'losa'|'sin', pretil:0.35}`; override por vano: ventana `vano.z = {antepecho, alto}`, puerta/corrediza `vano.z = {alto}`. Espesor: `geom.wallCm`. Lámina: `geom.sheet = {formato}`. Todo viaja dentro de `geom_json` (cero cambios de esquema en la hoja).
- APIs del motor para el editor de fachadas: `ed.updateElev(patch)` y `ed.updateVanoZ(kind, id, z|null)` — ambas pasan por `pushHistory` (deshacer normal) + `save` + `render`.

## Arquitectura

El motor guarda `geom` en localStorage `marbel_editor_geom_v1` en cada cambio. `crokiss-cloud.js` detecta cambios por polling de `getGeom()` (1.5 s) y sube con debounce 8 s solo si hay proyecto reclamado. Identidad en `crokiss_identity_v1`. En boot, `lastPushed = lastSeen` (sin versiones fantasma). El backend hace upsert por `(correo, clave)` y escribe Historial **solo** en guardado explícito.

## Decisiones importantes (no revertir sin razón)

1. Offline-first: NO reemplazar `save()` por fetch; detección por polling para no tocar el motor.
2. Zoom por viewBox, no por transform.
3. Identidad correo+clave; claves en texto plano asumidas para un croquis gratuito — pero `action=plan` jamás las devuelve.
4. Historial solo en guardado explícito.
5. Sin secretos en el front; anti-abuso ligero (honeypot, 45 KB, 60/correo).
6. Terreno = 4 muros perimetrales vía `loadGeom()`; `loadGeom` **vacía la pila de deshacer** (un ↶ tras abrir no debe resucitar el borrador anterior).
7. "✦ Nuevo" SIEMPRE suelta `ident` antes de sembrar el terreno (si no, el sync pisa el proyecto guardado).
8. La lámina no reconstruye `Planta Arquitectonica.html` (eliminado del flujo): `plan-sheet.js` es el único camino al entregable.

## URLs y datos

- Repo: https://github.com/alexpueblag/crokiss
- Sitio: https://alexpueblag.github.io/crokiss/
- `/exec`: https://script.google.com/macros/s/AKfycbxFtuOvgTIkZehUqcJUA7rWpULGncFLDRZEEPAKLhLTr73dP7v1QdcE73g7yrGdcZyHsg/exec
- Hoja: "CroKiss — Planos" (pestañas Planos e Historial)
- Esquema Planos: `ts, plan_id, client_id, nombre, correo, clave, plan_name, version, marketing, source, geom_json`
- Esquema Historial: `ts, plan_id, plan_name, correo, version, geom_json`

## Despliegue

Ver `OPERACION.md`. Resumen: front = subir TODOS los archivos al repo (incluye los nuevos `plan-sheet.js` y `plan-elev.js`) → Pages ~1 min → Ctrl+Shift+R. Backend = pegar `Code.gs` → Implementar → Gestionar implementaciones → **editar la implementación EXISTENTE** (lápiz) → Versión nueva. **NUNCA crear implementación nueva** (cambiaría la URL `/exec`). Crear el trigger semanal de `respaldoSemanal()` una sola vez.

## Siguiente paso

1. Desplegar front + backend (juntos: el front nuevo entiende los códigos viejos, pero el flujo `?open=ID` sin clave necesita el Code.gs nuevo para ser seguro).
2. Probar en producción: Nuevo (no pisa), abrir por enlace (pide clave), guardar con correo caído (muestra clave), Lámina/PDF, fachada.
3. Crear trigger de respaldo semanal + limpiar filas de prueba.
4. Después, por prioridad del informe: métricas de embudo, registro de 1 campo, `?plan=ID` compartible, upsert por `plan_id`, F2 de fachadas.

## Preferencias de trabajo

- Entorno: Chromebook (Crostini); prueba local con `python3 -m http.server 8000`.
- Trabajar en español, con pasos de ejecución detallados.
- Entregar archivos completos, no parches.
- Integridad de datos sobre presentación.
- NUNCA hacer POST de prueba al `/exec` de producción (cada guardado = lead real). Pruebas con `source='test'`.
