'use server'

import { revalidatePath } from 'next/cache'
import { apiFetch } from '@/lib/api'

/**
 * Acciones de /contactos: cada una revalida la vista y deja que el próximo
 * render (o el polling de /tareas) muestre el resultado. Sin estado de
 * cliente paralelo: la fuente de verdad es siempre la API.
 */

export async function syncContactsAction(): Promise<void> {
  await apiFetch('POST', '/contacts/sync')
  revalidatePath('/contactos')
  revalidatePath('/tareas')
}

export async function exportContactsAction(formData: FormData): Promise<void> {
  const includeSummaries = formData.get('includeSummaries') === 'on'
  await apiFetch('POST', '/contacts/export', { body: { includeSummaries } })
  revalidatePath('/tareas')
}

export async function updateBirthdayAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '')
  if (!id) return
  const month = String(formData.get('birthMonth') ?? '').trim()
  const day = String(formData.get('birthDay') ?? '').trim()
  const year = String(formData.get('birthYear') ?? '').trim()
  await apiFetch('PATCH', `/contacts/${id}`, {
    body: {
      birthMonth: month ? Number(month) : null,
      birthDay: day ? Number(day) : null,
      birthYear: year ? Number(year) : null,
    },
  })
  revalidatePath('/contactos')
}

export async function summarizeContactAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '')
  if (!id) return
  await apiFetch('POST', `/contacts/${id}/summarize`)
  revalidatePath('/tareas')
}
