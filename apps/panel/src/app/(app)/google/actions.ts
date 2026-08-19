'use server'

import { revalidatePath } from 'next/cache'
import { apiFetch } from '@/lib/api'

/**
 * Acciones de /google: cada una dispara su ruta de la API y revalida. El
 * avance de importar y crear eventos es una tarea del worker: se sigue en
 * /tareas, igual que sync y export.
 */

export async function importBirthdaysAction(): Promise<void> {
  await apiFetch('POST', '/google/birthdays/import')
  revalidatePath('/google')
  revalidatePath('/tareas')
  revalidatePath('/contactos')
}

export async function createEventsAction(): Promise<void> {
  await apiFetch('POST', '/google/birthdays/create-events')
  revalidatePath('/google')
  revalidatePath('/tareas')
}

export async function disconnectGoogleAction(): Promise<void> {
  await apiFetch('POST', '/google/disconnect')
  revalidatePath('/google')
}
