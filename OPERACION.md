# CroKiss — Manual de operación

Guía para operar CroKiss sin saber programar. Tiempo total de despliegue: ~10 min.

## 1. Desplegar el FRONT (la página)

1. Sube **todos** los archivos modificados/nuevos al repo `alexpueblag/crokiss` (rama principal):
   `index.html`, `plan-editor.js`, `crokiss-cloud.js`, `plan-sheet.js` (nuevo), `plan-elev.js` (nuevo).
2. Espera ~1 minuto a que GitHub Pages publique.
3. Abre https://alexpueblag.github.io/crokiss/ y recarga con **Ctrl+Shift+R** (recarga dura).

## 2. Desplegar el BACKEND (Code.gs)

⚠️ La regla de oro: **NUNCA crees una implementación nueva** — cambiaría la URL `/exec` y rompería el editor y todos los enlaces ya enviados por correo.

1. Abre la hoja "CroKiss — Planos" → Extensiones → Apps Script.
2. Borra el contenido de `Code.gs` y pega el archivo `Code.gs` del repo completo. Guarda (Ctrl+S).
3. Botón **Implementar** → **Gestionar implementaciones** → en la implementación existente pulsa el **lápiz** (editar) → en "Versión" elige **Versión nueva** → **Implementar**.
4. Prueba: abre `…/exec?action=ping` en el navegador → debe responder `{"ok":true,"pong":true}`.

Despliega front y backend **el mismo día**: el flujo "abrir por enlace" del front nuevo está pensado para el backend nuevo (que ya no regala la clave).

## 3. Respaldo semanal automático (hazlo UNA vez)

Tu hoja de leads es el activo del negocio; esto crea una copia semanal en Drive:

1. En Apps Script, menú izquierdo → **Activadores** (icono de reloj).
2. **+ Añadir activador** → Función: `respaldoSemanal` · Implementación: Principal · Fuente: Según tiempo · Tipo: **Temporizador semanal** · ej. lunes 4-5 am.
3. Guardar y aceptar los permisos de Drive.

Las copias quedan en la carpeta "CroKiss Respaldos" (se conservan las últimas 8).

## 4. Limpiar filas de prueba (UNA vez)

1. En la pestaña **Planos**, ordena o filtra por `correo` y borra las filas que reconozcas como pruebas tuyas.
2. Haz lo mismo en **Historial** (filtra por los mismos `plan_id`).
3. De hoy en adelante: si necesitas probar guardados reales, usa un correo tuyo y escribe `test` en la columna `source` de esa fila para excluirla de métricas.

## 5. Si los correos caen en spam

- Pide a 2-3 personas de confianza que marquen el correo como "No es spam" y agreguen el remitente a contactos.
- Verifica cuánta cuota de correo queda: en Apps Script ejecuta una función con `MailApp.getRemainingDailyQuota()` (Gmail gratuito ≈ 100/día; Workspace ≈ 1.500/día).
- Si el volumen crece, considera mover el envío a una cuenta Workspace del dominio aurumarquitectos.com (mejor entregabilidad y cuota).
- Red de seguridad ya integrada: si el correo no sale, la app muestra la clave en pantalla al usuario.

## 6. Explotar los leads (proceso quincenal, ~30 min)

1. Abre la pestaña **Planos** y filtra por `ts` de las últimas 2 semanas.
2. Exporta o copia: `nombre`, `correo`, `plan_name`, `marketing`.
3. Contacta a los que tengan `marketing = si` (ya te dieron permiso). Referencia personal: "vi tu proyecto «{plan_name}»".
4. Lleva una columna manual `contactado` / `respondió` / `cliente` en una pestaña aparte ("Seguimiento").
5. La métrica que importa: **correos únicos nuevos por semana** y **conversiones a cliente**. Si una quincena baja, revisa qué cambió en el portal de Yodesarrollo.

## 7. Prueba rápida después de cada despliegue (5 min)

1. Abre el sitio en incógnito → debe pedir el terreno → dibuja 2 muros.
2. Botón **⎙ Lámina / PDF** → debe verse el plano con cajetín y fachada → Cerrar.
3. **✦ Nuevo** → el aviso debe decir que tu proyecto guardado queda a salvo (si tenías uno).
4. Guarda con un correo tuyo (recuerda `source='test'` luego en la hoja) → debe llegar el correo → abre el enlace → debe pedirte la clave en una barra abajo, no entrar directo.
5. Si algo falla, compara con la versión anterior: `git log` del repo guarda cada despliegue.
