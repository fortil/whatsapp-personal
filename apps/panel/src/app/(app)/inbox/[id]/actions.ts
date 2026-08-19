'use server'

import { revalidatePath } from 'next/cache'
import { apiFetch } from '@/lib/api'
import type { TranscribeState } from './transcribe-state'

export type { TranscribeState }

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

/**
 * Botón "Transcribir" de un mensaje de audio. 409 (ya pending, carrera con
 * otro click o con el worker) no es error: el próximo refresh de 5 s ya trae
 * el estado real.
 */
export async function transcribeAction(
  prev: TranscribeState,
  formData: FormData,
): Promise<TranscribeState> {
  const messageId = String(formData.get('messageId') ?? '')
  const conversationId = String(formData.get('conversationId') ?? '')
  if (!messageId || !conversationId) {
    return { ...prev, error: 'falta el identificador del mensaje' }
  }

  const res = await apiFetch<{ error?: string; transcriptStatus?: string; transcript?: string | null }>(
    'POST',
    `/inbox/messages/${messageId}/transcribe`,
  )
  revalidatePath(`/inbox/${conversationId}`)

  if (res.status === 409) return { status: 'pending' }
  if (res.status !== 200) {
    return { ...prev, error: res.body?.error ?? 'no se pudo transcribir el audio' }
  }
  return { status: res.body.transcriptStatus, transcript: res.body.transcript ?? null }
}
