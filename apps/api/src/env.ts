/**
 * Lectura centralizada de variables de entorno. Los secretos obligatorios se
 * validan en el arranque (index.ts): la API no debe levantar sin JWT_SECRET
 * ni WEBHOOK_SECRET. El resto tiene default de dev y degrada por diseño.
 */
export type MailerDriverName = 'console' | 'resend'
export type SmsDriverName = 'console' | 'twilio'

export interface ApiEnv {
  databaseUrl: string
  redisUrl: string
  jwtSecret: string
  webhookSecret: string
  mailerDriver: MailerDriverName
  mailFrom: string
  resendApiKey: string
  smsDriver: SmsDriverName
  twilioAccountSid: string
  twilioAuthToken: string
  twilioVerifyServiceSid: string
  adminEmail: string
  apiPort: number
  evolutionApiUrl: string
  evolutionApiKey: string
  /** URL de esta API alcanzable desde el contenedor de Evolution (webhooks). */
  publicApiUrl: string
  /** URL del panel: adonde redirige /google/callback tras vincular. */
  panelUrl: string
  googleClientId: string
  googleClientSecret: string
  googleRedirectUri: string
  /** 32 bytes hex; cifra los refresh tokens de Google en reposo. */
  encryptionKey: string
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  return {
    databaseUrl: env.DATABASE_URL ?? '',
    redisUrl: env.REDIS_URL ?? '',
    jwtSecret: env.JWT_SECRET ?? '',
    webhookSecret: env.WEBHOOK_SECRET ?? '',
    mailerDriver: env.MAILER_DRIVER === 'resend' ? 'resend' : 'console',
    mailFrom: env.MAIL_FROM ?? 'WhatsApp Personal <no-reply@localhost>',
    resendApiKey: env.RESEND_API_KEY ?? '',
    smsDriver: env.SMS_DRIVER === 'twilio' ? 'twilio' : 'console',
    twilioAccountSid: env.TWILIO_ACCOUNT_SID ?? '',
    twilioAuthToken: env.TWILIO_AUTH_TOKEN ?? '',
    twilioVerifyServiceSid: env.TWILIO_VERIFY_SERVICE_SID ?? '',
    adminEmail: env.ADMIN_EMAIL ?? '',
    apiPort: Number(env.API_PORT ?? 3001),
    evolutionApiUrl: env.EVOLUTION_API_URL ?? '',
    evolutionApiKey: env.EVOLUTION_API_KEY ?? '',
    publicApiUrl: env.PUBLIC_API_URL ?? '',
    panelUrl: env.PANEL_URL ?? '',
    googleClientId: env.GOOGLE_CLIENT_ID ?? '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
    googleRedirectUri: env.GOOGLE_REDIRECT_URI ?? '',
    encryptionKey: env.ENCRYPTION_KEY ?? '',
  }
}

/**
 * Compuerta de arranque. Devuelve la lista de secretos faltantes; el caller
 * decide lanzar. Así index.ts arranca con un mensaje claro y los tests
 * inyectan su propio secreto sin pasar por process.env.
 */
export function missingStartupSecrets(env: ApiEnv): string[] {
  const missing: string[] = []
  if (!env.jwtSecret) missing.push('JWT_SECRET')
  if (!env.webhookSecret) missing.push('WEBHOOK_SECRET')
  // Google configurado a medias no puede arrancar: sin ENCRYPTION_KEY no hay
  // forma de guardar el refresh token de forma ilegible
  const anyGoogle = env.googleClientId || env.googleClientSecret || env.googleRedirectUri
  if (anyGoogle && !env.encryptionKey) missing.push('ENCRYPTION_KEY')
  return missing
}
