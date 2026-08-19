'use client'

import { useActionState } from 'react'
import { sendMessageAction, type ComposerState } from './actions'

const initial: ComposerState = {}

/** Composer del chat: Server Action contra la API, con revalidación de ruta. */
export default function Composer({ conversationId }: { conversationId: string }) {
  const [state, formAction, pending] = useActionState(sendMessageAction, initial)
  return (
    <form className="composer" action={formAction} key={state.sent ?? 0}>
      <input type="hidden" name="conversationId" value={conversationId} />
      <textarea
        name="text"
        rows={1}
        placeholder="Escribe un mensaje"
        enterKeyHint="send"
        required
      />
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Enviando…' : 'Enviar'}
      </button>
      {state.error ? <div className="form-error composer-error">{state.error}</div> : null}
    </form>
  )
}
