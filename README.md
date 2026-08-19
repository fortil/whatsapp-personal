# whatsapp-personal

Plataforma personal multi-usuario cuyo núcleo es WhatsApp. Cada cliente se
registra con celular colombiano y correo, el admin lo aprueba, vincula su
WhatsApp mediante Evolution API y desde el panel puede leer y responder sus
chats, transcribir notas de voz, exportar contactos con resúmenes generados
por LLM a Excel, y vincular Google para importar cumpleaños de sus contactos
y crearlos como eventos anuales en su calendario.

Auth en dos pasos: contraseña más OTP por correo (Resend), con dispositivo de
confianza y fallback por SMS (Twilio Verify). El registro verifica el correo
antes de gastar un solo SMS.

## Requisitos

- Node >= 22 y pnpm 10 (`corepack enable` resuelve la versión del
  `package.json`; el gestor está bloqueado a pnpm).
- Docker con Docker Compose para postgres, redis y Evolution API.
- Opcional: una máquina en la LAN con Ollama y whisper.cpp para el modo local
  (ver `docs/mac-mini-setup.md`). Sin ella, `LLM_PROVIDER=dashscope` y una
  clave de DashScope cubren resúmenes y transcripción.

## Levantar en local

```bash
cp .env.example .env          # llena al menos JWT_SECRET y WEBHOOK_SECRET:
                              # openssl rand -hex 32 para cada una
docker compose up -d postgres redis
pnpm install
pnpm db-migrate               # migraciones drizzle versionadas
pnpm db-seed                  # superadmin desde ADMIN_EMAIL/PHONE/PASSWORD
pnpm verify                   # build + typecheck + tests de todo el monorepo
```

El primer acceso es el del seed: `/login` con `ADMIN_EMAIL` y
`ADMIN_PASSWORD`. Con `MAILER_DRIVER=console` y `SMS_DRIVER=console` (los
defaults) los códigos OTP aparecen en el log de la API, así que el flujo
completo de registro y login funciona sin credenciales de proveedor.

Para correr los tres servicios en dev, cada uno en su terminal:

```bash
pnpm -r build                 # api y worker hacen --watch sobre dist
pnpm -F @wp/api dev           # API en :3001
pnpm -F @wp/worker dev        # worker BullMQ, health en :3002
pnpm -F @wp/panel dev         # panel Next.js en :3000
```

Evolution API (`docker compose up -d evolution`) solo hace falta para vincular
WhatsApp real; con `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` vacíos las rutas
`/channel/*` responden 503 y el resto de la plataforma funciona.

## Mapa del monorepo

| Ruta | Qué es |
|---|---|
| `apps/api` | Fastify 5 en :3001. Auth, admin, canal, inbox, contactos, tareas, Google, webhooks. |
| `apps/worker` | BullMQ. Transcripción, sync de contactos, resúmenes, export a Excel, cumpleaños, reaper. |
| `apps/panel` | Next.js 15 App Router en :3000, CSS plano. El navegador jamás llama a la API: todo pasa por Server Actions. |
| `packages/db` | Drizzle + postgres.js. Schema, client, migraciones versionadas en `drizzle/`, seed. |
| `packages/channels` | Cliente de Evolution API, solo fetch. |
| `packages/llm` | LLM y ASR: proveedor local (Ollama, whisper.cpp) o DashScope. Costos por modelo. |
| `packages/mailer` | Correo transaccional. Drivers `console` y `resend`; plantillas email-safe. |
| `packages/google` | OAuth, People API, Calendar API con fetch crudo. Refresh tokens cifrados en reposo. |
| `packages/shared` | Validación y normalización de teléfonos CO (libphonenumber-js). |
| `infra/` | `postgres-init.sql`: pgcrypto y base `evolution` para el contenedor. |
| `docs/` | Guías de operación: `mac-mini-setup.md`, `proveedores.md`. |

## Variables de entorno

La lista completa con comentarios vive en `.env.example`. Resumen de
obligatorias y degradaciones:

| Variable | Obligatoria | Sin ella |
|---|---|---|
| `DATABASE_URL`, `REDIS_URL` | sí | la API no arranca |
| `JWT_SECRET`, `WEBHOOK_SECRET` | sí | la API no arranca |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `PUBLIC_API_URL` | no | `/channel/*` e inbox de respuesta responden 503 |
| `LLM_PROVIDER`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL` | no | sin proveedor de LLM los resúmenes fallan con error claro |
| `LOCAL_ASR_BASE_URL`, `DASHSCOPE_API_KEY`, `OPENAI_API_KEY` | no | transcripción degrada en cadena (local → DashScope → OpenAI → error claro) |
| `MAILER_DRIVER`, `RESEND_API_KEY`, `MAIL_FROM` | no | driver `console`: los códigos van al log |
| `SMS_DRIVER`, `TWILIO_*` | no | driver `console`: ídem |
| `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`, `ENCRYPTION_KEY` | no | rutas `/google/*` responden 503; `ENCRYPTION_KEY` es obligatoria si hay `GOOGLE_*` |
| `PANEL_URL`, `API_URL`, `EXPORT_DIR`, `ADMIN_*`, `API_PORT`, `WORKER_PORT` | no | defaults documentados en `.env.example` |

Los secretos se generan con `openssl rand -hex 32`.

## Proveedores reales

El flujo completo corre con drivers `console`. Para correo real (Resend), SMS
real (Twilio Verify con Fraud Guard) y vinculación de Google, los pasos
humanos exactos están en `docs/proveedores.md`: nadie los recuerda a los tres
meses, por eso viven escritos.

## Seguridad, en corto

- Aislamiento por `user_id` en toda query (sin RLS); verificado por
  `apps/api/src/isolation.test.ts` sobre toda la superficie autenticada.
- Rate limits en redis: login 5/min por IP y 10/h por identificador, signup
  10/min y 5/día por IP, SMS 3/día por teléfono, OTP de login por SMS 2/hora,
  forgot 5/min por IP, reenvío de código 3/5min, verificación de teléfono
  5/min por IP.
- Anti-enumeración en registro y recuperación: respuestas genéricas, y ningún
  SMS se dispara contra cuentas existentes.
- Suspensión efectiva inmediata: el gate de estado lee `users.status` de la
  DB en cada request autenticado.

## Operación

- `pnpm verify` es el gate de cada fase; los tests de la API y del worker son
  de integración contra el postgres y redis del compose.
- Migraciones siempre con `pnpm db:generate` (versiona en `packages/db/drizzle/`)
  y `pnpm db-migrate`; nunca `drizzle-kit push`.
- El reaper del worker marca `error` las tareas colgadas, los audios
  `pending` de más de 10 minutos y borra exports con más de 30 días.
