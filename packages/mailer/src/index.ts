export { createMailer } from './mailer.js'
export type { Mailer, MailerDriver, MailerOptions, MailMessage } from './mailer.js'
export {
  accountApprovedEmail,
  emailChangeCodeEmail,
  loginCodeEmail,
  passwordResetCodeEmail,
  pendingApprovalAdminEmail,
  signupAttemptWarningEmail,
  signupCodeEmail,
  tempPasswordEmail,
} from './templates.js'
export type { MailContent } from './templates.js'
