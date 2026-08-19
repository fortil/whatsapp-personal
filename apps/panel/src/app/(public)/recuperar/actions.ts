'use server'

import { redirect } from 'next/navigation'
import { apiFetch } from '@/lib/api'

export interface RecoverState {
  step: 1 | 2
  email: string
  error?: string
  ok?: string
}

export async function recoverAction(_prev: RecoverState, formData: FormData): Promise<RecoverState> {
  const stage = String(formData.get('stage') ?? 'request')
  const email = String(formData.get('email') ?? '').trim().toLowerCase()

  if (stage === 'request') {
    if (!email) return { step: 1, email, error: 'Escribe el correo de tu cuenta.' }
    const res = await apiFetch('POST', '/auth/forgot', { body: { identifier: email } })
    if (res.status !== 200) return { step: 1, email, error: 'no se pudo enviar el código' }
    return { step: 2, email, ok: 'Si la cuenta existe, el código va en camino.' }
  }

  const code = String(formData.get('code') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  if (!code || password.length < 10) {
    return { step: 2, email, error: 'Código y contraseña nueva (mínimo 10 caracteres).' }
  }
  const res = await apiFetch<{ error?: string }>('POST', '/auth/reset-password', {
    body: { email, code, password },
  })
  if (res.status !== 200) return { step: 2, email, error: res.body.error ?? 'código inválido' }
  redirect('/login?ok=password-changed')
}
