/**
 * Plantillas de correo del sistema. Email-safe de verdad: tablas anidadas con
 * role="presentation", CSS 100% inline, nada de flex, grid, media queries,
 * variables CSS ni bloques <style> (los clientes de correo los ignoran o los
 * rompen). Cada plantilla lleva versión de texto plano y todo dato de usuario
 * pasa por esc() antes de entrar en el HTML.
 */

const BRAND = 'WhatsApp Personal'
const ACCENT = '#0F8A55'
const TEXT = '#0E211A'
const MUTED = '#5B7268'
const BG = '#F5F8F5'
const BORDER = '#D9E4DC'

/** Escape de HTML para los datos de usuario que se interpolan. */
function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Casilla grande para códigos de 6 dígitos: legible también en texto. */
function codeRow(code: string): string {
  const cells = code
    .split('')
    .map(
      (d) =>
        `<td align="center" style="padding:0 4px;"><div style="width:44px;height:52px;line-height:52px;border:1px solid ${BORDER};border-radius:10px;background:#FFFFFF;font-size:24px;font-weight:700;color:${TEXT};font-family:'Instrument Sans',Arial,sans-serif;text-align:center;">${d}</div></td>`,
    )
    .join('')
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:24px auto;"><tr>${cells}</tr></table>`
}

function layout(title: string, preheader: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BG};">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(preheader)}</div>
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" bgcolor="${BG}" style="background:${BG};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="480" style="max-width:480px;width:100%;background:#FFFFFF;border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">
<tr><td style="padding:24px 32px 0 32px;font-family:'Bricolage Grotesque',Arial,sans-serif;font-size:15px;font-weight:700;color:${ACCENT};">${BRAND}</td></tr>
<tr><td style="padding:8px 32px 0 32px;font-family:'Bricolage Grotesque',Arial,sans-serif;font-size:22px;font-weight:700;color:${TEXT};">${esc(title)}</td></tr>
<tr><td style="padding:16px 32px 32px 32px;font-family:'Instrument Sans',Arial,sans-serif;font-size:15px;line-height:22px;color:${MUTED};">${inner}</td></tr>
<tr><td style="padding:0 32px 24px 32px;font-family:'Instrument Sans',Arial,sans-serif;font-size:12px;line-height:18px;color:${MUTED};border-top:1px solid ${BORDER};">Si no esperabas este correo, ignóralo. No reenvíes códigos a nadie.</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`
}

export interface MailContent {
  subject: string
  html: string
  text: string
}

const TTL = 'Expira en 15 minutos.'

export function signupCodeEmail(code: string): MailContent {
  return {
    subject: `${BRAND}: tu código de verificación`,
    text: `Tu código para verificar tu correo es ${code}. ${TTL}`,
    html: layout(
      'Verifica tu correo',
      `Tu código de verificación es ${code}.`,
      `<p style="margin:0 0 4px 0;">Ingresa este código en la pantalla de verificación:</p>${codeRow(code)}<p style="margin:0;">${TTL}</p>`,
    ),
  }
}

export function loginCodeEmail(code: string): MailContent {
  return {
    subject: `${BRAND}: tu código de acceso`,
    text: `Tu código para iniciar sesión es ${code}. ${TTL}`,
    html: layout(
      'Código de acceso',
      `Tu código de acceso es ${code}.`,
      `<p style="margin:0 0 4px 0;">Alguien inició sesión con tu cuenta. Si fuiste tú, ingresa este código:</p>${codeRow(code)}<p style="margin:0;">${TTL} Si no fuiste tú, cambia tu contraseña.</p>`,
    ),
  }
}

export function passwordResetCodeEmail(code: string): MailContent {
  return {
    subject: `${BRAND}: código para restablecer tu contraseña`,
    text: `Tu código para restablecer la contraseña es ${code}. ${TTL}`,
    html: layout(
      'Restablecer contraseña',
      `Código para restablecer tu contraseña: ${code}.`,
      `<p style="margin:0 0 4px 0;">Usa este código para elegir una contraseña nueva:</p>${codeRow(code)}<p style="margin:0;">${TTL}</p>`,
    ),
  }
}

export function emailChangeCodeEmail(code: string): MailContent {
  return {
    subject: `${BRAND}: confirma tu correo nuevo`,
    text: `Tu código para confirmar el cambio de correo es ${code}. ${TTL}`,
    html: layout(
      'Confirma tu correo nuevo',
      `Código para confirmar tu correo nuevo: ${code}.`,
      `<p style="margin:0 0 4px 0;">Pediste cambiar el correo de tu cuenta a esta dirección. Código de confirmación:</p>${codeRow(code)}<p style="margin:0;">${TTL}</p>`,
    ),
  }
}

export function pendingApprovalAdminEmail(user: { email: string; phone: string }): MailContent {
  return {
    subject: `${BRAND}: usuario pendiente de aprobación`,
    text: `Se registró ${user.email} (${user.phone}) y espera aprobación en el panel de administración.`,
    html: layout(
      'Usuario pendiente de aprobación',
      `Se registró ${user.email} y espera tu aprobación.`,
      `<p style="margin:0 0 8px 0;">Un usuario completó el registro y espera tu aprobación:</p>` +
        `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="width:100%;font-family:'Instrument Sans',Arial,sans-serif;font-size:14px;color:${TEXT};">` +
        `<tr><td style="padding:4px 0;color:${MUTED};">Correo</td><td style="padding:4px 0;font-weight:700;">${esc(user.email)}</td></tr>` +
        `<tr><td style="padding:4px 0;color:${MUTED};">Celular</td><td style="padding:4px 0;font-weight:700;">${esc(user.phone)}</td></tr>` +
        `</table>` +
        `<p style="margin:16px 0 0 0;">Entra al panel, sección administración, para aprobarlo o rechazarlo.</p>`,
    ),
  }
}

export function accountApprovedEmail(panelUrl: string): MailContent {
  return {
    subject: `${BRAND}: tu cuenta fue aprobada`,
    text: `Tu cuenta fue aprobada. Entra a ${panelUrl} para iniciar sesión.`,
    html: layout(
      'Tu cuenta fue aprobada',
      'Tu cuenta fue aprobada; ya puedes iniciar sesión.',
      `<p style="margin:0;">William aprobó tu registro. Ya puedes <a href="${esc(panelUrl)}" style="color:${ACCENT};font-weight:700;">iniciar sesión</a> y vincular tu WhatsApp.</p>`,
    ),
  }
}

export function tempPasswordEmail(password: string): MailContent {
  return {
    subject: `${BRAND}: tu contraseña temporal`,
    text: `Tu contraseña temporal es ${password}. Cámbiala apenas entres, desde Cuenta.`,
    html: layout(
      'Contraseña temporal',
      'Tu contraseña temporal llegó; cámbiala al entrar.',
      `<p style="margin:0 0 4px 0;">Un administrador restableció tu contraseña. Tu acceso temporal:</p>` +
        `<div style="margin:16px 0;padding:12px 16px;border:1px solid ${BORDER};border-radius:10px;background:#FFFFFF;font-family:'Instrument Sans',Arial,sans-serif;font-size:18px;font-weight:700;color:${TEXT};text-align:center;">${esc(password)}</div>` +
        `<p style="margin:0;">Cámbiala apenas entres, desde la sección Cuenta.</p>`,
    ),
  }
}

export function signupAttemptWarningEmail(): MailContent {
  return {
    subject: `${BRAND}: intento de registro con tu correo`,
    text: 'Alguien intentó registrarse con tu correo. Si no fuiste tú, ignora este mensaje; tu cuenta no cambió.',
    html: layout(
      'Intento de registro con tu correo',
      'Alguien intentó registrarse con tu correo; tu cuenta no cambió.',
      `<p style="margin:0;">Alguien intentó crear una cuenta con este correo. Si no fuiste tú no pasa nada: tu cuenta no cambió y no se envió ningún SMS. Si el registro sí fue tuyo y no lograste verificarlo, usa el mismo correo y celular de nuevo o escríbele al administrador.</p>`,
    ),
  }
}
