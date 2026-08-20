'use client'

import { useActionState } from 'react'
import { recoverAction, type RecoverState } from './actions'

export default function RecoverForm() {
  const [state, formAction, pending] = useActionState<RecoverState, FormData>(recoverAction, {
    step: 1,
    email: '',
  })

  return (
    <form action={formAction}>
      {state.error ? <div className="form-error">{state.error}</div> : null}
      {state.ok ? <div className="form-ok">{state.ok}</div> : null}

      {state.step === 1 ? (
        <>
          <div className="field">
            <label htmlFor="email">Correo de tu cuenta</label>
            <input id="email" name="email" type="email" autoComplete="email" required autoFocus />
          </div>
          <button type="submit" name="stage" value="request" className="btn btn-primary" style={{ width: '100%' }} disabled={pending}>
            {pending ? 'Enviando…' : 'Enviar código'}
          </button>
        </>
      ) : (
        <>
          <input type="hidden" name="email" value={state.email} />
          <p className="auth-hint">
            Código enviado a <strong>{state.email}</strong>.
          </p>
          <div className="field">
            <label htmlFor="code">Código de 6 dígitos</label>
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
          <div className="field">
            <label htmlFor="password">Contraseña nueva (mínimo 10)</label>
            <input id="password" name="password" type="password" minLength={10} autoComplete="new-password" required />
          </div>
          <button type="submit" name="stage" value="reset" className="btn btn-primary" style={{ width: '100%' }} disabled={pending}>
            {pending ? 'Cambiando…' : 'Cambiar contraseña'}
          </button>
        </>
      )}
    </form>
  )
}
