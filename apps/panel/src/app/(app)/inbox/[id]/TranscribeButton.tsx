'use client'

import { useActionState } from 'react'
import { transcribeAction } from './actions'
import { mergeTranscribeState, transcribeView, type TranscribeState } from './transcribe-state'

const initial: TranscribeState = {}

/**
 * Cuatro estados del audio: none → botón, pending → spinner de texto, done →
 * transcripción inline (o aviso de "sin voz" si el ASR no detectó habla),
 * error → mensaje + botón para reintentar. El servidor (props) manda en
 * cuanto avanza más allá de 'none', así que el chip "Transcribiendo…" no
 * queda clavado cuando el AutoRefresh de 5 s trae done o error: ver
 * `mergeTranscribeState` y `transcribeView`.
 */
export default function TranscribeButton({
  messageId,
  conversationId,
  status,
  transcript,
}: {
  messageId: string
  conversationId: string
  status: string
  transcript: string | null
}) {
  const [state, formAction, pending] = useActionState(transcribeAction, initial)
  const { status: effectiveStatus, transcript: effectiveTranscript } = mergeTranscribeState(
    status,
    transcript,
    state,
  )
  const view = transcribeView(effectiveStatus, effectiveTranscript)

  if (view === 'transcript') {
    return (
      <div className="transcript-block">
        <p className="transcript-text">{effectiveTranscript}</p>
      </div>
    )
  }

  if (view === 'no-voice') {
    return (
      <div className="transcript-block">
        <p className="transcript-text">No se detectó voz en el audio.</p>
      </div>
    )
  }

  if (pending || view === 'pending') {
    return (
      <div className="transcript-block">
        <span className="chip">Transcribiendo…</span>
      </div>
    )
  }

  return (
    <div className="transcript-block">
      <form action={formAction}>
        <input type="hidden" name="messageId" value={messageId} />
        <input type="hidden" name="conversationId" value={conversationId} />
        <button type="submit" className="btn btn-sm">
          {effectiveStatus === 'error' ? 'Reintentar transcripción' : 'Transcribir'}
        </button>
      </form>
      {state.error ? <p className="transcript-error">{state.error}</p> : null}
    </div>
  )
}
