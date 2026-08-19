'use server'

import { revalidatePath } from 'next/cache'
import { apiFetch } from '@/lib/api'

export async function userAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '')
  const op = String(formData.get('op') ?? '')
  if (!id || !op) return

  const res = await apiFetch('POST', `/admin/users/${id}/${op}`)
  if (res.status >= 500) console.error(`[panel] ${op} falló para ${id}:`, res.status)
  revalidatePath('/admin/usuarios')
  revalidatePath('/admin')
}

export async function correctEmailAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '')
  const email = String(formData.get('email') ?? '').trim()
  if (!id || !email) return

  const res = await apiFetch<{ error?: string }>('PUT', `/admin/users/${id}/email`, { body: { email } })
  if (res.status !== 200) console.error('[panel] corregir correo falló:', res.body.error)
  revalidatePath('/admin/usuarios')
}

export async function resetPasswordAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '')
  if (!id) return
  const res = await apiFetch('POST', `/admin/users/${id}/reset-password`)
  if (res.status !== 200) console.error('[panel] reset de contraseña falló:', res.status)
  revalidatePath('/admin/usuarios')
}
