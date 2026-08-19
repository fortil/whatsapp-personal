'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { signupAction, type SignupState } from './actions'

export default function RegistroForm() {
  const [state, formAction, pending] = useActionState<SignupState, FormData>(signupAction, {})

  return (
    <form action={formAction}>
      {state.error ? <div className="form-error">{state.error}</div> : null}
      <div className="field">
        <label htmlFor="phone">Celular (Colombia)</label>
        <input id="phone" name="phone" type="tel" placeholder="300 123 4567" autoComplete="tel" required autoFocus />
      </div>
      <div className="field">
        <label htmlFor="email">Correo</label>
        <input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="field">
        <label htmlFor="password">Contraseña (mínimo 10 caracteres)</label>
        <input id="password" name="password" type="password" minLength={10} autoComplete="new-password" required />
      </div>
      <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={pending}>
        {pending ? 'Registrando…' : 'Crear cuenta'}
      </button>
      <p className="auth-alt">
        ¿Ya tienes cuenta? <Link href="/login">Entrar</Link>
      </p>
    </form>
  )
}
