'use server'

import { redirect } from 'next/navigation'
import { apiFetch } from '@/lib/api'

export interface VerifyState {
  step: 1 | 2
  email: string
  error?: string
  ok?: string
}

export async function verifyFlowAction(_prev: VerifyState, formData: FormData): Promise<VerifyState> {
  const stage = String(formData.get('stage') ?? 'email')
  const email = String(formData.get('email') ?? '').trim().toLowerCase()

  if (stage === 'resend') {
    const res = await apiFetch<{ error?: string }>('POST', '/auth/verify/resend', { body: { email } })
    if (res.status !== 200) return { step: _prev.step, email, error: res.body.error ?? 'no se pudo reenviar' }
    return { step: _prev.step, email, ok: 'Código reenviado.' }
  }

  if (stage === 'email') {
    const code = String(formData.get('code') ?? '').trim()
    if (!code) return { step: 1, email, error: 'Escribe el código que llegó a tu correo.' }
    const res = await apiFetch<{ error?: string }>('POST', '/auth/verify/email', { body: { email, code } })
    if (res.status !== 200) return { step: 1, email, error: res.body.error ?? 'código inválido' }
    return { step: 2, email, ok: 'Correo verificado. Ahora el código que llegó por SMS.' }
  }

  // stage === 'phone'
  const phone = String(formData.get('phone') ?? '').trim()
  const code = String(formData.get('code') ?? '').trim()
  if (!phone || !code) return { step: 2, email, error: 'Escribe tu celular y el código SMS.' }
  const res = await apiFetch<{ error?: string; status?: string }>('POST', '/auth/verify/phone', {
    body: { phone, code },
  })
  if (res.status !== 200) return { step: 2, email, error: res.body.error ?? 'código inválido' }
  redirect('/pendiente')
}
