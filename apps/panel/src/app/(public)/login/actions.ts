'use server'

import { redirect } from 'next/navigation'
import { apiFetch, applyApiCookies, homeFor, setMetaCookie } from '@/lib/api'

export interface LoginState {
  step: 1 | 2
  error?: string
  ok?: string
}

interface LoginBody {
  error?: string
  session?: boolean
  otp?: string
  user?: { role: string; status: string }
}

/**
 * Un solo action para el flujo completo: el botón que envía el formulario
 * decide la etapa (`name="stage"`), así el estado de un solo useActionState
 * gobierna las transiciones y no se pisan.
 */
export async function loginFlowAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const stage = String(formData.get('stage') ?? 'credentials')

  if (stage === 'credentials') {
    const identifier = String(formData.get('identifier') ?? '').trim()
    const password = String(formData.get('password') ?? '')
    if (!identifier || !password) return { step: 1, error: 'Escribe tu correo o celular y tu contraseña.' }

    const res = await apiFetch<LoginBody>('POST', '/auth/login', { body: { identifier, password } })
    if (res.status !== 200) return { step: 1, error: res.body.error ?? 'no se pudo iniciar sesión' }
    await applyApiCookies(res.setCookies)

    if (res.body.session && res.body.user) {
      await setMetaCookie(res.body.user)
      redirect(homeFor(res.body.user))
    }
    return { step: 2, ok: 'Enviamos un código a tu correo.' }
  }

  if (stage === 'sms') {
    const res = await apiFetch<LoginBody>('POST', '/auth/login/verify/sms')
    if (res.status !== 200) return { step: 2, error: res.body.error ?? 'no se pudo enviar el SMS' }
    return { step: 2, ok: 'Código enviado por SMS a tu celular.' }
  }

  // stage === 'verify'
  const code = String(formData.get('code') ?? '').trim()
  const rememberDevice = formData.get('rememberDevice') === 'on'
  if (!code) return { step: 2, error: 'Escribe el código de 6 dígitos.' }

  const res = await apiFetch<LoginBody>('POST', '/auth/login/verify', { body: { code, rememberDevice } })
  if (res.status === 401) return { step: 1, error: res.body.error ?? 'la verificación expiró' }
  if (res.status !== 200) return { step: 2, error: res.body.error ?? 'código inválido' }

  await applyApiCookies(res.setCookies)
  if (res.body.user) await setMetaCookie(res.body.user)
  redirect(homeFor(res.body.user ?? { role: 'user' }))
}
