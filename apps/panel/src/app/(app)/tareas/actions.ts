'use server'

import { revalidatePath } from 'next/cache'

/** Refresco del listado (polling 5 s del panel). */
export async function refreshTasksAction(): Promise<void> {
  revalidatePath('/tareas')
}
