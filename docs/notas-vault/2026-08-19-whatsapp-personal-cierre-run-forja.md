---
tema: whatsapp-personal
tipo: nota
proyecto: whatsapp-personal
creada: 2026-08-19
actualizada: 2026-08-19
estado: cerrado
aliases: ["whatsapp-personal cierre MVP", "whatsapp-personal fases 0-7"]
tags: [whatsapp-personal, forja, whatsapp, evolution-api, auth, google-calendar]
---

# whatsapp-personal: cierre del run que construyó el proyecto (fases 0-7)

## Resumen
Run de forja en modo `hacer` (PLAN.md externo como contrato, sin fase de
planificación) que construyó desde cero **whatsapp-personal**: registro con
celular colombiano + email, aprobación del admin, vinculación de WhatsApp por
Evolution API, inbox, transcripción de audios, export de contactos con
resúmenes de LLM y Google Calendar con cumpleaños. Ocho fases (0-7), commits
`d45b5ae`..`7035ada` en `goal/whatsapp-personal`, 271 tests en verde con
`pnpm verify`. Vueltas por fase: 0 y 4 cerraron en la primera; 1, 2, 3, 5 y 6
necesitaron una vuelta de rechazo; la 7 necesitó tres y agotó el presupuesto
ampliado (3 en vez de 2). El código de aplicación quedó completo y probado;
lo que falta es exclusivamente infraestructura y credenciales que no existían
durante el run (detalle abajo).

## Decisiones de diseño y su porqué
- **Watermark de resúmenes con `+1ms`** (`packages/db/src/schema.ts:169`
  `summary_thru_created_at`; `apps/worker/src/jobs/summarize.ts:358-370`). El
  `key.id` de WhatsApp no ordena y los mensajes offline llegan tarde, así que
  el corte usa el reloj de inserción de Postgres (`created_at`), no el id. El
  `+1ms` existe porque `postgres.js` trunca el timestamptz (microsegundos) a
  milisegundos al leerlo: sin el margen, la fila que puso el watermark podía
  "reaparecer" como `created_at > watermark` en la siguiente pasada
  incremental y duplicar trabajo.
- **No-leído derivado, sin contador** (`messages`, índice parcial
  `(conversation_id) WHERE direction='in' AND read_at IS NULL`). El conteo se
  calcula por count exacto sobre ese índice en vez de mantener
  `unread_count`. Es idempotente por construcción ante retries del webhook:
  no hay incremento que decrementar dos veces.
- **`ON CONFLICT (conversation_id, external_id) DO NOTHING` en las dos rutas
  de inserción** (`apps/api/src/services/ingest.ts:168,200,285` y
  `apps/api/src/routes/inbox.ts:261`). Cubre la carrera entre el webhook de
  Evolution y la respuesta HTTP del propio envío, y los retries de Evolution:
  ninguno de los dos caminos produce 500 ni fila duplicada.
- **Cumpleaños como fecha pura** (`start.date`/`end.date` sin componente de
  hora en el evento de Calendar). El servidor de producción vive en
  `ap-southeast-1` (Singapur, UTC+8); una fecha con timezone se habría
  desplazado un día al verse desde Bogotá. La fecha pura es inmune al huso
  del servidor por diseño, no por casualidad de zona horaria coincidente.
- **Registro email-antes-que-SMS**. El signup solo dispara el OTP de Twilio
  Verify después de `email_verified_at`; el email es gratis y el SMS cuesta.
  Es la primera barrera de las tres contra SMS pumping (junto con el rate
  por teléfono y Fraud Guard en consola).
- **Dispositivo de confianza + fallback SMS en login** (cookie `wp_trusted`,
  JWT 30 días; botón "recibir por SMS" en `/auth/login/verify/sms`). Ambos
  existen contra la caída de Resend: sin trusted device, cada login exige un
  correo; sin el fallback, un email caído en spam deja a todo el mundo,
  incluido el admin, sin poder entrar.

## Hallazgos de review que evitaron un fallo real
- **Fase 5, vuelta 1** (`fase5-WORK_REVIEW-loop1.md`): los scopes de OAuth
  pedidos (`calendar.events` + `contacts.readonly`) no autorizan leer
  `people/me.emailAddresses`. Contra Google real, el callback nunca habría
  completado la vinculación ("no se pudo leer el correo de tu cuenta de
  Google"). La suite no lo detectaba porque el doble de `fetch` fabricaba el
  campo `emailAddresses` en la respuesta. Se cerró añadiendo el scope
  `userinfo.email`. Lección explícita del revisor: un doble de fetch debe
  codificar también lo que los scopes concedidos pueden devolver, no solo la
  forma de la respuesta.
- **Fase 6, vuelta 1** (`fase6-WORK_REVIEW-loop1.md`): `pnpm verify`
  intermitente al ~2% por corrida. Los teléfonos de test se generan de un tag
  `% 1000` contra una DB compartida; runs abortados dejan residuo (19 filas
  huérfanas contadas por el revisor) que colisiona con `users_phone_unique`.
  Ese intermitente había estado envenenando el gate verde de todas las fases
  anteriores sin que nadie lo notara. Se cerró con limpieza determinista por
  patrón en el setup, no ampliando el espacio del tag.
- **Fase 6, vuelta 1**, mismo review: regresión de anti-enumeración. Al
  mejorar los mensajes de error de Twilio en `/auth/verify/phone` (ruta
  pública, sin rate limit), el cuerpo de la respuesta pasó a distinguir
  teléfono registrado de no registrado en una sola petición. Antes del
  cambio el cuerpo era uniforme para ambos casos. Se cerró mostrando el
  mensaje específico solo con una verificación abierta de verdad, más rate
  limit propio en la ruta.
- **Patrón repetido cuatro veces en la Fase 7** (`fase7-WORK_REVIEW.md`,
  sección "Para el registro de aprendizaje"): lo que corre en CI o en el
  servidor hay que verificarlo desde una copia limpia del repo, no desde la
  máquina de desarrollo. Los cuatro episodios: `tsbuildinfo` del host
  colándose al contexto de build; `packages/db/drizzle/` faltante en la
  imagen de runtime (el migrate del deploy moría con "Can't find
  meta/_journal.json"); el job `compose` de CI validando el overlay de
  producción sin el `.env` que el checkout limpio no trae; y, en la última
  vuelta, cuatro tests de `apps/api` que pasaban en local porque heredaban
  `LOCAL_ASR_BASE_URL` del `.env` de la máquina y fallaban en GitHub Actions
  porque esa variable no existe ahí. Este último se cerró con el presupuesto
  de vueltas agotado: el orquestador aplicó la corrección que el revisor ya
  había prescrito literalmente (fijar la variable en `beforeAll` y
  restaurarla en `afterAll`, patrón ya presente en
  `apps/api/src/isolation.test.ts:247-257`) y la verificó en una copia limpia
  con solo archivos versionados: 119 tests en verde, decisivo completo con
  271 tests.

## Pendientes que dependen de una persona
Nada de esto existió durante el run (código + runbook, sin credenciales
simuladas):
- Cuenta de Alibaba Cloud, instancia `ecs.e-c1m4.large` (2 vCPU/8GB) en
  `ap-southeast-1`, disco `cloud_essd_entry` 40GB.
- Dominio con los tres registros A y el TXT de SPF, más DKIM/DMARC cuando
  Resend los genere.
- Repo en GitHub con los secrets `ECS_HOST`, `ECS_USER`, `ECS_SSH_KEY`, y
  `docker login ghcr.io` en el servidor con un PAT `read:packages`.
- Secretos de producción (`openssl rand -hex 32`): `JWT_SECRET`,
  `WEBHOOK_SECRET`, `ENCRYPTION_KEY`, `POSTGRES_PASSWORD`,
  `EVOLUTION_API_KEY`.
- Altas de proveedor: dominio verificado en Resend; Twilio con Verify
  Service y Fraud Guard (duda abierta: sender registrado para Colombia);
  cliente OAuth de Google con `redirect_uri` en
  `https://api.<dominio>/google/callback` (en modo Testing los refresh
  tokens caducan a los 7 días); `DASHSCOPE_API_KEY` del endpoint
  internacional. Pasos detallados en `docs/proveedores.md`.
- Mac mini M4: elegir el modelo local definitivo entre `qwen3:8b`/`14b` y
  `gemma3:12b-it-qat`, benchmark de resúmenes en español, latencia de ASR y
  `memory_pressure` con whisper + 16k ctx cargados (pendiente desde la Fase
  3, checklist en `docs/mac-mini-setup.md`).

**Antes de lo anterior, un pendiente de código**: el hallazgo crítico que
cerró la Fase 7 sigue vivo para GitHub real —`ci.yml` job `verify` necesita
una variable de ASR resoluble (`LOCAL_ASR_BASE_URL` de un host cualquiera
basta) o el test de `inbox-transcribe.test.ts` migrado al patrón
`beforeAll`/`afterAll`. Verificado localmente, nunca en Actions.

**Orden de verificación cuando exista servidor y cuentas**
(`fase7-WORK_REVIEW.md`, "Estado del proyecto al cierre"): 1) CI en verde en
GitHub (verify/compose/images) 2) push a `main` publica las tres imágenes en
ghcr y el deploy llega al gate de salud 3) `curl` al health del api y
certificado del panel (si Let's Encrypt no emite, el problema es DNS o
grupo de seguridad) 4) webhook real: vincular WhatsApp, mandar un mensaje,
verlo en el inbox en <5s 5) `backup.sh`/`restore-drill.sh` en el servidor el
primer día 6) `docker stats` con Evolution vinculado para saber si los 8GB
aguantan 7) un rollback a mano sin usuarios todavía.

## Incidentes de proceso
- **Dos agotamientos de cuota de GLM** (Fase 3 y Fase 7) y **uno de Kimi**
  (403 en Fase 7). Escalera de respaldo usada: GLM → Kimi → Claude. En la
  Fase 3 el peldaño de "modelo menor" (`glm --small`) no sirvió: el 429 es
  de cuenta, no de modelo.
- **Disco de la VM de Docker lleno a 16 GiB** (Fase 2, vuelta 1): rechazo de
  entorno, no de código (`wp-postgres` sano por dentro pero sin puerto
  publicado). El usuario subió el disco a 48 GiB. Efecto colateral avisado:
  el reinicio de Docker paró el contenedor `drone-delivery-sitl` de otro
  proyecto del usuario.
- **Error del orquestador al sondear cuota** (Fase 4): un prompt de una
  palabra para comprobar si GLM había vuelto lanzó una sesión de Claude Code
  con `bypassPermissions` dentro del directorio del repo (el wrapper `glm`
  solo bloquea `git commit|push|reset`, no `checkout --` ni borrados). Sin
  tarea real, la sesión improvisó y revirtió archivos sin commitear mientras
  el implementador trabajaba en paralelo. Los commits quedaron intactos
  (reflog limpio) y el implementador reconstruyó lo perdido, pero la lección
  quedó explícita en `RUN_STATE.md`: **los sondeos de cuota van fuera del
  repo**.

## Datos útiles para el futuro
- Comando decisivo final: `docker compose up -d postgres redis && pnpm
  db-migrate && pnpm verify && docker compose -f docker-compose.yml -f
  docker-compose.prod.yml config >/dev/null` → exit 0, 271 tests.
- Para reproducir lo que ve CI (sin GitHub), correr los tests de `apps/api`
  con el entorno recortado del job `verify`, no con el `.env` de la
  máquina: ver el comando completo en `fase7-WORK_REVIEW.md`, sección
  "Feedback accionable", punto 1.
- Bitácora completa fase por fase: `RUN_STATE.md`. Brief, reporte y review
  (incluidas las vueltas rechazadas) de cada fase: `.forja/fases/faseN-*.md`.
- El plan completo, con el layout del repo, el schema de DB y las decisiones
  técnicas en tabla: `PLAN.md` (raíz del repo).

## Enlaces
- Plan (fuente de verdad del run): `PLAN.md`
- Estado y bitácora: `RUN_STATE.md`
- Cierre con estado del proyecto para retomar en 3 meses:
  `.forja/fases/fase7-WORK_REVIEW.md` (sección "Estado del proyecto al
  cierre")
