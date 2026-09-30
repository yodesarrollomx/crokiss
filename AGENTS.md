# Instrucciones para agentes — crokiss

Lee completo `CLAUDE.md` y las instrucciones locales del área antes de editar. Sus reglas de negocio, despliegue y pruebas siguen aplicando.

La referencia transversal es el [atlas de YOD OS](https://github.com/yodesarrollomx/yod-portal/blob/main/docs/arquitectura/README.md). Consulta su `modelo.json`, mapas, procesos y registro de propuestas antes de cambiar comportamiento. No copies datos privados al atlas público.

Componentes de este repositorio: `SYS-CROKISS`, `GAS-CROKISS`, `SHEET-CROKISS`.

1. Identifica los componentes y conexiones afectados y la fuente de verdad de cada dato. Distingue lo observado en código de lo comprobado en ejecución.
2. Propón primero el cambio en el modelo y los diagramas centrales, con impacto, invariantes, pruebas y rollback. Una propuesta comercial pendiente no autoriza alterar precios, permisos o reglas de negocio.
3. Actualiza `architecture-impact.json` con la revisión del modelo aprobado, su propuesta, componentes y pruebas concretas. La revisión inicial es `2026-09-30.1`.
4. Implementa el cambio, ejecuta las verificaciones aplicables y registra su resultado. Si cambia la arquitectura, actualiza el atlas y fija su nuevo commit en el workflow antes de integrar.
5. Conserva en Git el historial del cambio. Una validación estructural del manifiesto no demuestra funcionamiento en producción: documenta por separado las comprobaciones pendientes.

Verificaciones locales aplicables:

- git diff --check
- node pruebas/backend.js

El workflow `Arquitectura YOD` compara el cambio con una versión fija del atlas; incluye las comprobaciones automatizadas declaradas en su archivo. Las revisiones manuales y pruebas de producción se documentan por separado. La activación como comprobación obligatoria corresponde a la configuración del repositorio y debe verificarse, especialmente si hay bots programados.

Revertir el commit de este cambio mediante revisión y repetir las verificaciones locales. No borrar ni restaurar registros de negocio, Sheets o archivos de clientes como parte del rollback. Las migraciones de credenciales irreversibles conservan su regla local de corrección hacia delante; este cambio de gobierno no las ejecuta.

Usa datos sintéticos y dobles para verificar integraciones. No pruebes escrituras en endpoints de producción ni publiques credenciales, datos personales o contenido privado en archivos o logs públicos.
