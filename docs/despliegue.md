# Despliegue: runbook de producción

Todo lo que hay que hacer a mano para poner la plataforma en el ECS de
Alibaba Cloud (Singapur) y mantenerla. Lo que hace el código ya está: este
documento cubre la parte humana.

Estado al escribir esto: los tres `docker build` (api, worker, panel)
corrieron de verdad, igual que `compose config` sobre los dos overlays y el
restore drill completo (`infra/deploy/backup.sh` + `infra/deploy/restore-drill.sh`
contra la base local). Se probó además, dentro de la imagen de api, el
comando de migración que corre `deploy.sh` antes del rollout (`node
packages/db/dist/migrate.js` contra un postgres local), porque construir la
imagen no basta para saber que puede hacer su trabajo. Los workflows de
`.github/` se revisaron a mano y se validó su YAML, pero no corrieron en
GitHub Actions: eso exige un repo remoto. No había cuenta de Alibaba,
servidor, dominio ni repo de GitHub en el run, así que los pasos de consola
de abajo están sin ejecutar. Cada sección dice qué verificar al terminarla.

## Qué corre en el servidor

Un solo ECS con todo el stack por compose:

- `postgres` (la base de la app y la de Evolution) y `redis`, sin puertos
  publicados.
- `evolution` (WhatsApp), sin puertos publicados.
- `api` y `worker`: la misma imagen de Docker, dos servicios (`APP=api` /
  `APP=worker`).
- `panel` (Next.js standalone).
- `caddy`: el único con puertos en el host (80 y 443), con HTTPS automático
  de Let's Encrypt para `panel.$DOMAIN` y `api.$DOMAIN`.

`/opt/whatsapp-personal` no es un clon de git: todo llega por rsync desde el
workflow. El `.env` y `backups/` viven ahí y el workflow jamás los toca (los
rsync van sin `--delete` sobre la raíz).

## 1. Provisión del ECS

En la consola de Alibaba Cloud (región `ap-southeast-1`, Singapur, cerca del
endpoint internacional de DashScope que usa producción):

1. ECS → Crear instancia:
   - Tipo: `ecs.e-c1m4.large` (2 vCPU, 8 GB). Con 4 GB swapea en carga
     normal: Evolution crece 150-300 MB por instancia vinculada y el stack
     completo no cabe.
   - Imagen: Ubuntu 24.04.
   - Disco del sistema: `cloud_essd_entry`, 40 GB.
   - Par de claves para SSH (crear uno si no hay).
2. Grupo de seguridad: permitir 22 (ssh, idealmente solo desde tu IP), 80 y
   443. Nada más: postgres, redis y el 8080 de Evolution no se publican.
3. Al quedar activa, anotar la IP pública. Si es efímera, fijar una IP
   elástica antes de configurar el DNS.

Verificación: `ssh -i <clave> ubuntu@<ip> uptime` responde.

## 2. Preparación del servidor

```bash
# docker + compose (repo oficial)
sudo apt-get update && sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-compose-plugin
sudo usermod -aG docker $USER   # y reloguearse

# destino del deploy
sudo mkdir -p /opt/whatsapp-personal && sudo chown $USER /opt/whatsapp-personal

# acceso a las imágenes (privadas por defecto): un PAT clásico de GitHub
# con scope read:packages, una sola vez
docker login ghcr.io -u <usuario-github>
```

## 3. El `.env` de producción

Copiar `.env.example` a `/opt/whatsapp-personal/.env` y llenar:

- Secretos nuevos (`openssl rand -hex 32` cada uno): `JWT_SECRET`,
  `WEBHOOK_SECRET`, `ENCRYPTION_KEY`, `POSTGRES_PASSWORD` (este va sin
  `postgres`), `EVOLUTION_API_KEY`.
- `DOMAIN=tudominio.com` e `IMAGE_OWNER=<usuario-github>`: los usa el
  compose para armar nombres de imagen y URLs.
- `LLM_PROVIDER=dashscope` con `DASHSCOPE_API_KEY`. Las variables
  `LOCAL_LLM_*` no van: la Mac mini no se expone a internet.
- `MAILER_DRIVER=resend` y `SMS_DRIVER=twilio` con sus credenciales
  (pasos en `docs/proveedores.md`).
- `GOOGLE_REDIRECT_URI=https://api.tudominio.com/google/callback` más
  `GOOGLE_CLIENT_ID/SECRET`.
- `PANEL_URL=https://panel.tudominio.com` (adonde redirige tras vincular
  Google).
- `ADMIN_EMAIL/PHONE/PASSWORD` para el seed del superadmin.

`DATABASE_URL`, `REDIS_URL`, `API_URL`, `PUBLIC_API_URL`, `EVOLUTION_API_URL`
y `EXPORT_DIR` no hay que tocarlos en `.env`: los fija el compose de
producción con los nombres de servicio internos.

## 4. DNS

Cuatro registros:

- **Tres A** hacia la IP del ECS: `api.tudominio.com` y `panel.tudominio.com`
  (los que sirve Caddy) más la raíz `tudominio.com`. La raíz no sirve web
  aquí (Caddy solo tiene hosts para `api.` y `panel.`); se apunta igual
  porque es el dominio del que sale el correo, y un registro A en la raíz es
  requisito previo habitual antes de que un proveedor de correo valide el
  dominio.
- **Un TXT de SPF** en la raíz, para que el correo saliente (los OTP de
  registro y login) no caiga en spam desde el primer envío. El valor exacto
  lo da la consola de Resend al verificar el dominio.

DKIM y DMARC llevan su propio TXT cada uno, pero no entran en esta cuenta de
cuatro: dependen de una clave que genera la consola de Resend en el momento
de verificar el dominio, así que se documentan junto al resto de esa puesta
en marcha en `docs/proveedores.md`, no aquí.

Verificación: `dig +short api.tudominio.com` devuelve la IP.

## 5. GitHub

El repo necesita tres secrets (Settings → Secrets and variables → Actions):
`ECS_HOST` (IP o hostname), `ECS_USER` (el usuario ssh, ej. `ubuntu`) y
`ECS_SSH_KEY` (la clave privada completa). Para ghcr no hace falta nada: el
workflow usa el `GITHUB_TOKEN` automático.

## 6. Primer despliegue

Al subir a `main`, `deploy.yml` corre CI, publica las tres imágenes en
ghcr.io etiquetadas `latest` y `:${sha}`, sube la configuración por rsync a
`/opt/whatsapp-personal` y ejecuta por SSH `infra/deploy/deploy.sh`:
backup, migraciones drizzle (forward-only, antes del rollout), `pull`,
`up -d`, gate de salud sobre api, worker y panel, y si el gate falla,
rollback automático re-etiquetando la imagen anterior.

La primera vez, en un servidor recién provisionado, no existe todavía el
contenedor de postgres: `deploy.sh` lo detecta y salta el paso de backup en
vez de abortar (no hay nada que respaldar), y sigue directo a las
migraciones, que crean el schema desde cero.

Para el arranque inicial hay que sembrar el superadmin una vez:

```bash
cd /opt/whatsapp-personal
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T api node packages/db/dist/seed.js
```

También hay que instalar el cron del backup (sección Backups de abajo).

Verificación (smoke-test post-deploy):

```bash
curl -fsS https://api.tudominio.com/health        # {"status":"ok",...}
curl -fsSI https://panel.tudominio.com/login      # 200 por HTTPS
```

Y el flujo real: registrarse desde el panel (email + SMS), aprobar el
usuario desde `/admin`, vincular WhatsApp y comprobar que el QR llega y que
un mensaje entrante aparece en el inbox (el webhook viaja por
`https://api.tudominio.com/webhooks/evolution/<instancia>`; si el inbox no
se llena, `docker compose ... logs api | grep webhook`).

## 7. Rollback

A un sha ya publicado (todos quedan en ghcr):

```bash
cd /opt/whatsapp-personal
TAG=<sha> bash infra/deploy/rollback.sh
```

Con `TAG=latest` vuelve a la última publicada. La forma cruda, si se
prefiere a mano, es la misma que usa el script:
`TAG=<sha> docker compose -f docker-compose.yml -f docker-compose.prod.yml
up -d --no-build`.

Las migraciones son forward-only: el rollback recupera el código anterior,
no deshace migraciones ya aplicadas. Es una de las razones por las que el
plan exige migraciones aditivas.

## 8. Backups

`infra/deploy/backup.sh` hace `pg_dump | gzip` a `backups/` con rotación de
14 días (deploy.sh también lo corre antes de cada rollout). Instalar el cron
diario en el crontab del usuario (`crontab -e`):

```
10 3 * * * cd /opt/whatsapp-personal && bash infra/deploy/backup.sh >> backups/backup.log 2>&1
```

La hora es la del servidor (comprobar con `timedatectl`; las instancias de
Alibaba suelen quedar en UTC por defecto). Los datos de la app usan
`timestamptz` y el panel renderiza en `America/Bogota`, así que la zona del
servidor no afecta los datos, solo a qué hora corre el cron.

Cada mes, y siempre después de un cambio grande en el schema, correr el
restore drill (levanta un postgres efímero, restaura el último backup y
compara tablas y filas contra la base origen):

```bash
bash infra/deploy/restore-drill.sh
```

## 9. Limpieza periódica

- **Base `evolution`**: Evolution guarda su propio historial completo de
  mensajes y crece sin control. Una vez al mes medir:
  ```bash
  docker compose -f docker-compose.yml -f docker-compose.prod.yml \
    exec -T postgres psql -U postgres -d evolution \
    -c "SELECT pg_size_pretty(pg_database_size('evolution'))"
  ```
  Si crece, revisar las tablas más grandes (`\dt+` dentro de esa base) y
  borrar el historial viejo de las tablas de mensajes con una fecha de corte
  (p. ej. 90 días), con backup fresco y fuera de horas de uso. La app no
  depende de ese historial: lo suyo vive en `whatsapp_personal`.
- **Imágenes viejas en el ECS**: cada deploy deja los sha anteriores, que
  son el historial de rollback. Cuando el disco apriete,
  `docker image prune` borra las que no usa ningún contenedor.
- **Exports**: el reaper del worker ya borra los xlsx de más de 30 días.

## 10. Operación diaria

- Logs: `docker compose -f docker-compose.yml -f docker-compose.prod.yml
  logs -f api worker`. Todos los servicios rotan logs (10 MB x 3).
- Estado: `... ps` (la columna de salud es el mismo gate que usa deploy.sh).
- Disco: `df -h /` y `docker system df`. El disco entra en 40 GB; los
  candidatos a llenarlo son la base `evolution` y las imágenes.
