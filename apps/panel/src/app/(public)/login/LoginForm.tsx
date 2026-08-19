'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { loginFlowAction, type LoginState } from './actions'

const initial: LoginState = { step: 1 }

export default function LoginForm({ passwordChanged }: { passwordChanged?: boolean }) {
  const [state, formAction, pending] = useActionState(loginFlowAction, initial)

  if (state.step === 2) {
    return (
      <form action={formAction}>
        {state.error ? <div className="form-error">{state.error}</div> : null}
        {state.ok ? <div className="form-ok">{state.ok}</div> : null}
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
        <label className="check">
          <input type="checkbox" name="rememberDevice" />
          Confiar en este dispositivo (30 días sin códigos)
        </label>
        <div className="row" style={{ marginTop: 16 }}>
          <button type="submit" name="stage" value="verify" className="btn btn-primary" disabled={pending}>
            {pending ? 'Verificando…' : 'Entrar'}
          </button>
          <button type="submit" name="stage" value="sms" className="btn" disabled={pending}>
            Recibir por SMS
          </button>
        </div>
      </form>
    )
  }

  return (
    <form action={formAction}>
      {state.error ? <div className="form-error">{state.error}</div> : null}
      {passwordChanged ? <div className="form-ok">Contraseña cambiada. Entra con la nueva.</div> : null}
      <div className="field">
        <label htmlFor="identifier">Correo o celular</label>
        <input id="identifier" name="identifier" autoComplete="username" required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="password">Contraseña</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <button type="submit" name="stage" value="credentials" className="btn btn-primary" style={{ width: '100%' }} disabled={pending}>
        {pending ? 'Entrando…' : 'Entrar'}
      </button>
      <p className="auth-alt">
        <Link href="/recuperar">Olvidé mi contraseña</Link>
      </p>
    </form>
  )
}
