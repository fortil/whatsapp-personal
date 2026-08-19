'use server'

import { revalidatePath } from 'next/cache'

/** Refresco de la lista de conversaciones (polling 15 s del panel). */
export async function refreshInboxAction(): Promise<void> {
  revalidatePath('/inbox')
}
