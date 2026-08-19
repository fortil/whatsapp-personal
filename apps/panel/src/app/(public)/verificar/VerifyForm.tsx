'use client'

import { useActionState } from 'react'
import { verifyFlowAction, type VerifyState } from './actions'

export default function VerifyForm({ initialEmail }: { initialEmail: string }) {
  const [state, formAction, pending] = useActionState<VerifyState, FormData>(verifyFlowAction, {
    step: 1,
    email: initialEmail,
  })

  return (
    <form action={formAction}>
      {state.error ? <div className="form-error">{state.error}</div> : null}
      {state.ok ? <div className="form-ok">{state.ok}</div> : null}

      <input type="hidden" name="email" value={state.email} />

      {state.step === 1 ? (
        <>
          <p className="auth-hint">
            Enviamos un código de 6 dígitos a <strong>{state.email || 'tu correo'}</strong>.
          </p>
          <div className="field">
            <label htmlFor="code">Código del correo</label>
            <input
              id="code"
              name="code"
              className="code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              required
            />
          </div>
          <div className="row">
            <button type="submit" name="stage" value="email" className="btn btn-primary" disabled={pending}>
              {pending ? 'Verificando…' : 'Verificar correo'}
            </button>
            <button type="submit" name="stage" value="resend" className="btn" disabled={pending}>
              Reenviar código
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <label htmlFor="phone">Tu celular</label>
            <input id="phone" name="phone" type="tel" placeholder="300 123 4567" autoComplete="tel" required />
          </div>
          <div className="field">
            <label htmlFor="code">Código SMS</label>
            <input
              id="code"
              name="code"
              className="code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
            />
          </div>
          <div className="row">
            <button type="submit" name="stage" value="phone" className="btn btn-primary" disabled={pending}>
              {pending ? 'Verificando…' : 'Verificar celular'}
            </button>
          </div>
        </>
      )}
    </form>
  )
}
