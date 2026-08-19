'use server'

import { redirect } from 'next/navigation'
import { apiFetch } from '@/lib/api'

export interface SignupState {
  error?: string
}

export async function signupAction(_prev: SignupState, formData: FormData): Promise<SignupState> {
  const phone = String(formData.get('phone') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim().toLowerCase()
  const password = String(formData.get('password') ?? '')

  if (!phone || !email || !password) return { error: 'Completa los tres campos.' }
  if (password.length < 10) return { error: 'La contraseña debe tener al menos 10 caracteres.' }

  const res = await apiFetch<{ error?: string }>('POST', '/auth/signup', { body: { phone, email, password } })
  if (res.status !== 200) return { error: res.body.error ?? 'no se pudo registrar' }

  // la API responde igual exista o no la cuenta: a /verificar con el correo
  redirect(`/verificar?email=${encodeURIComponent(email)}`)
}
