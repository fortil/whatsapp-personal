# Proveedores reales: puesta en marcha

Pasos humanos para encender Resend, Twilio Verify y Google OAuth. El código ya
está: cada sección termina en qué variables de entorno fijar y con qué
verificar que quedó andando. Los tres drivers tienen modo `console`, así que
nada de esto bloquea el desarrollo local.

Estado actual: **el envío real de correo y SMS está sin verificar contra las
APIs en vivo** (no hubo credenciales en el run que escribió esto). Los drivers
están probados con dobles que reproducen las respuestas reales de cada API;
faltan los pasos de abajo ejecutados por una persona.

## Resend (correo transaccional)

1. Crear la cuenta en resend.com y verificar el correo del dueño.
2. **Verificar el dominio** desde el que se envía: Domains → Add Domain, con
   el dominio desnudo (ej. `tudominio.com`). Publicar en el DNS los registros
   que muestra la consola:
   - **DKIM**: TXT en `resend._domainkey.tudominio.com` con la clave que
     genera Resend (es la parte que firma cada correo).
   - **SPF**: el TXT de la raíz del dominio debe incluir el include de Resend
     (ej. `v=spf1 include:_spf.resend.com ~all`; el valor exacto lo muestra
     la consola).
   - **DMARC**: TXT en `_dmarc.tudominio.com` (ej.
     `v=DMARC1; p=none; rua=mailto:postmaster@tudominio.com`).
   Esperar el estado Verified en Resend. Sin DKIM el correo llega, pero cae
   en spam con frecuencia.
3. Generar la API key (API Keys → Create, permiso Full Access) y fijar en
   `.env`:
   ```
   MAILER_DRIVER=resend
   RESEND_API_KEY=re_xxxxxxxx
   MAIL_FROM=WhatsApp Personal <no-reply@tudominio.com>
   ```
   `MAIL_FROM` debe usar el dominio verificado; si no, Resend responde 422 y
   el driver lo loguea con esa pista.
4. Verificar: registrarse con un correo real y recibir el código. Si no llega,
   revisar el log de la API (`[mailer:resend]`) y la pestaña Emails de Resend:
   ahí se ve si fue rechazo (401 clave mala, 422 dominio) o problema de
   entrega.

Límites de la capa gratuita (100 correos/día, 3000/mes al escribir esto):
suficientes para OTP de una plataforma personal.

## Twilio Verify (OTP por SMS)

1. Crear la cuenta en twilio.com. Verify factura por envío y por
   verificación; no requiere comprar un número para los SMS de Verify.
2. En la consola: Verify → Services → Create new. Nombre libre (ej.
   `whatsapp-personal`), Friendly Name es lo que verán los usuarios en el
   cuerpo del SMS. Copiar el **Verify Service SID** (`VA...`).
3. **Activar Fraud Guard**: Verify → Settings → Fraud Guard. Es la mitigación
   contra el SMS pumping que exige el plan: bloquea envíos masivos a rangos
   de números sospechosos antes de que facturen. Requiere un balance
   prepago o haber pagado la primera factura; activarlo en modo preview y
   luego en bloqueo total cuando la señal sea estable.
4. Para Colombia: Verify entrega con mensajería propia y no exige sender
   registrado, pero Twilio puede pedirlo según el volumen y el tipo de
   cuenta; si un envío a un número CO falla con "not deliverable" o similar,
   el caso es soporte de Twilio, no configuración local.
5. Fijar en `.env` (Account SID y Auth Token de la consola principal):
   ```
   SMS_DRIVER=twilio
   TWILIO_ACCOUNT_SID=ACxxxxxxxx
   TWILIO_AUTH_TOKEN=xxxxxxxx
   TWILIO_VERIFY_SERVICE_SID=VAxxxxxxxx
   ```
6. Verificar: registrarse con un celular CO real; el SMS debe llegar con el
   código. El chequeo de límites locales sigue aplicando (3 SMS por teléfono
   al día) además del rate limit del propio Verify.

## Google (cumpleaños: Contacts y Calendar)

1. En console.cloud.google.com, crear el proyecto (ej. `whatsapp-personal`).
2. **Pantalla de consentimiento OAuth** (APIs & Services → OAuth consent
   screen): tipo External, nombre de la app, correo de soporte. No hace falta
   enviar a verificación mientras la app esté en modo Testing con usuarios de
   prueba registrados (Test users: agregar los correos que se van a vincular).
3. **Los tres scopes** que pide la plataforma (agréguelos manuales en la
   pestaña de scopes, no son sensibles, no requieren verificación):
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/contacts.readonly`
   - `https://www.googleapis.com/auth/userinfo.email`
4. **Credenciales**: Create Credentials → OAuth client ID → Web application.
   En Authorized redirect URIs, la URL exacta de la API:
   `{PUBLIC_API_URL}/google/callback` (en dev,
   `http://localhost:3001/google/callback`). Copiar Client ID y Client
   Secret.
5. Fijar en `.env`:
   ```
   GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
   GOOGLE_REDIRECT_URI=http://localhost:3001/google/callback
   ENCRYPTION_KEY=<openssl rand -hex 32>
   ```
   `ENCRYPTION_KEY` cifra los refresh tokens en la base (AES-256-GCM). Si se
   pierde, todas las vinculaciones quedan inservibles y hay que re-vincular.
6. Verificar: en el panel, sección Google, vincular, aceptar los permisos y
   correr el import de cumpleaños.

Advertencias que muerden a los tres meses:

- **Modo Testing**: los refresh tokens de usuarios de prueba caducan a los
  7 días; la vinculación deja de refrescar silenciosamente y hay que
  re-vincular. La salida es publicar la app (Publishing status → In
  production); con estos scopes no sensibles no requiere auditoría externa.
- **Cambiar o agregar scopes** invalida los grants existentes: toda cuenta ya
  conectada debe re-vincular para conceder el permiso nuevo. Si un día se
  agrega un scope, avisar a los usuarios conectados antes del deploy.
