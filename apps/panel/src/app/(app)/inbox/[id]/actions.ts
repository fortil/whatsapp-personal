'use server'

import { revalidatePath } from 'next/cache'
import { apiFetch } from '@/lib/api'

export interface ComposerState {
  /** Contador de envíos: al cambiar, remonta el form y limpia el textarea. */
  sent?: number
  error?: string
}

export async function sendMessageAction(
  prev: ComposerState,
  formData: FormData,
): Promise<ComposerState> {
  const conversationId = String(formData.get('conversationId') ?? '')
  const text = String(formData.get('text') ?? '').trim()
  if (!conversationId || !text) {
    return { ...prev, error: 'Escribe un mensaje antes de enviar.' }
  }
  const res = await apiFetch<{ error?: string }>(
    'POST',
    `/inbox/conversations/${conversationId}/messages`,
    { body: { text } },
  )
  if (res.status !== 200) {
    return { ...prev, error: res.body?.error ?? 'No se pudo enviar el mensaje.' }
  }
  revalidatePath(`/inbox/${conversationId}`)
  return { sent: (prev.sent ?? 0) + 1 }
}

/** Refresco del chat abierto (polling 5 s del panel). */
export async function refreshChatAction(conversationId: string): Promise<void> {
  revalidatePath(`/inbox/${conversationId}`)
}
