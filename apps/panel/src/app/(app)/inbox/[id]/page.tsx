import Link from 'next/link'
import { notFound } from 'next/navigation'
import AutoRefresh from '@/components/AutoRefresh'
import { apiFetch } from '@/lib/api'
import { formatTime } from '@/lib/dates'
import Composer from './Composer'
import { refreshChatAction } from './actions'

/**
 * Chat de una conversación. Marca leído al abrir (la llamada es idempotente)
 * y refresca cada 5 s por Server Action. Los medios se muestran como chip de
 * tipo; la reproducción llega con la transcripción (fase 3).
 */

interface MessageItem {
  id: string
  direction: 'in' | 'out'
  type: string
  body: string | null
  mediaMime: string | null
  sentAt: string
}

interface MessagesResponse {
  conversation: { id: string; waJid: string; name: string }
  messages: MessageItem[]
  nextCursor: string | null
}

const TYPE_LABEL: Record<string, string> = {
  audio: 'Audio',
  image: 'Imagen',
  video: 'Video',
  document: 'Documento',
  sticker: 'Sticker',
  other: 'Mensaje',
}

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ cursor?: string }>
}) {
  const { id } = await params
  const { cursor } = await searchParams

  await apiFetch('POST', `/inbox/conversations/${id}/read`)

  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  const res = await apiFetch<MessagesResponse>('GET', `/inbox/conversations/${id}/messages${qs}`)
  if (res.status !== 200) notFound()

  const { conversation, messages, nextCursor } = res.body
  const refresh = refreshChatAction.bind(null, id)

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ marginBottom: 0 }}>{conversation.name}</h1>
        <Link className="btn btn-sm" href="/inbox">
          Volver
        </Link>
      </div>

      <div className="chat">
        <div className="chat-scroll">
          {nextCursor ? (
            <div className="chat-more">
              <Link href={`/inbox/${id}?cursor=${encodeURIComponent(nextCursor)}`}>
                Ver mensajes anteriores
              </Link>
            </div>
          ) : null}
          {[...messages].reverse().map((m) => (
            <div key={m.id} className={`bubble ${m.direction}`}>
              {m.type === 'text' ? (
                m.body
              ) : (
                <span className="chip">{TYPE_LABEL[m.type] ?? 'Mensaje'}</span>
              )}
              <span className="msg-time">{formatTime(m.sentAt)}</span>
            </div>
          ))}
        </div>
        <Composer conversationId={id} />
      </div>

      <AutoRefresh intervalMs={5000} action={refresh} />
    </>
  )
}
