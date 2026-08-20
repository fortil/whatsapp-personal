'use server'

import { revalidatePath } from 'next/cache'
import { apiFetch } from '@/lib/api'

export interface AccountState {
  passwordError?: string
  passwordOk?: boolean
  emailStep: 1 | 2
  emailValue: string
  emailError?: string
  emailOk?: string
}

export async function changePasswordAction(
  _prev: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const currentPassword = String(formData.get('currentPassword') ?? '')
  const newPassword = String(formData.get('newPassword') ?? '')
  if (newPassword.length < 10) {
    return { ..._prev, passwordError: 'La contraseña nueva debe tener al menos 10 caracteres.' }
  }
  const res = await apiFetch<{ error?: string }>('POST', '/auth/change-password', {
    body: { currentPassword, newPassword },
  })
  if (res.status !== 200) return { ..._prev, passwordError: res.body.error ?? 'no se pudo cambiar' }
  return { ..._prev, passwordError: undefined, passwordOk: true }
}

export async function changeEmailAction(_prev: AccountState, formData: FormData): Promise<AccountState> {
  const stage = String(formData.get('stage') ?? 'request')

  if (stage === 'request') {
    const newEmail = String(formData.get('newEmail') ?? '').trim().toLowerCase()
    if (!newEmail) return { ..._prev, emailStep: 1, emailValue: '', emailError: 'Escribe el correo nuevo.' }
    const res = await apiFetch<{ error?: string }>('POST', '/auth/change-email', { body: { newEmail } })
    if (res.status !== 200) {
      return { ..._prev, emailStep: 1, emailValue: '', emailError: res.body.error ?? 'no se pudo enviar' }
    }
    return {
      ..._prev,
      emailStep: 2,
      emailValue: newEmail,
      emailError: undefined,
      emailOk: `Código enviado a ${newEmail}.`,
    }
  }

  const code = String(formData.get('code') ?? '').trim()
  const res = await apiFetch<{ error?: string }>('POST', '/auth/change-email/verify', {
    body: { newEmail: _prev.emailValue, code },
  })
  if (res.status !== 200) return { ..._prev, emailStep: 2, emailError: res.body.error ?? 'código inválido' }
  revalidatePath('/cuenta')
  return { ..._prev, emailStep: 1, emailValue: '', emailError: undefined, emailOk: 'Correo cambiado.' }
}

export async function revokeDeviceAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '')
  if (id) await apiFetch('POST', `/auth/devices/${id}/revoke`)
  revalidatePath('/cuenta')
}
