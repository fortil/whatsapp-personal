'use client'

import { useActionState } from 'react'
import { changeEmailAction, changePasswordAction, type AccountState } from './actions'

const initial: AccountState = { emailStep: 1, emailValue: '' }

export function PasswordForm() {
  const [state, formAction, pending] = useActionState(changePasswordAction, initial)
  return (
    <form action={formAction}>
      {state.passwordError ? <div className="form-error">{state.passwordError}</div> : null}
      {state.passwordOk ? <div className="form-ok">Contraseña cambiada.</div> : null}
      <div className="field">
        <label htmlFor="currentPassword">Contraseña actual</label>
        <input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
      </div>
      <div className="field">
        <label htmlFor="newPassword">Contraseña nueva (mínimo 10)</label>
        <input id="newPassword" name="newPassword" type="password" minLength={10} autoComplete="new-password" required />
      </div>
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Cambiando…' : 'Cambiar contraseña'}
      </button>
    </form>
  )
}

export function EmailForm() {
  const [state, formAction, pending] = useActionState(changeEmailAction, initial)
  return (
    <form action={formAction}>
      {state.emailError ? <div className="form-error">{state.emailError}</div> : null}
      {state.emailOk && state.emailStep === 1 ? <div className="form-ok">{state.emailOk}</div> : null}
      {state.emailStep === 1 ? (
        <>
          <p className="auth-hint">El cambio pide un código enviado al correo nuevo.</p>
          <div className="field">
            <label htmlFor="newEmail">Correo nuevo</label>
            <input id="newEmail" name="newEmail" type="email" required />
          </div>
          <button type="submit" name="stage" value="request" className="btn btn-primary" disabled={pending}>
            {pending ? 'Enviando…' : 'Enviar código'}
          </button>
        </>
      ) : (
        <>
          <div className="form-ok">{state.emailOk}</div>
          <div className="field">
            <label htmlFor="code">Código de 6 dígitos</label>
            <input
              id="code"
              name="code"
              className="code-input"
              inputMode="numeric"
              maxLength={6}
              autoFocus
              required
            />
          </div>
          <button type="submit" name="stage" value="confirm" className="btn btn-primary" disabled={pending}>
            {pending ? 'Confirmando…' : 'Confirmar cambio'}
          </button>
        </>
      )}
    </form>
  )
}
