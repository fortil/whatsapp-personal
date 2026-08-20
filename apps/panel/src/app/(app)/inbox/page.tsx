import Link from 'next/link'
import AutoRefresh from '@/components/AutoRefresh'
import { apiFetch } from '@/lib/api'
import { formatDateTime } from '@/lib/dates'
import { refreshInboxAction } from './actions'

/**
 * Lista de conversaciones con el no-leído derivado que calcula la API. El
 * polling de 15 s refresca por Server Action.
 */

interface ConversationItem {
  id: string
  waJid: string
  name: string
  unread: number
  lastMessageAt: string | null
  lastMessage: { body: string | null; type: string; direction: string } | null
}

const TYPE_LABEL: Record<string, string> = {
  audio: 'Audio',
  image: 'Imagen',
  video: 'Video',
  document: 'Documento',
  sticker: 'Sticker',
  other: 'Mensaje',
}

function preview(item: ConversationItem): string {
  const last = item.lastMessage
  if (!last) return 'Sin mensajes'
  if (last.body) return last.body
  return TYPE_LABEL[last.type] ?? 'Mensaje'
}

export default async function InboxPage() {
  const res = await apiFetch<{ items: ConversationItem[] }>('GET', '/inbox/conversations')
  const items = res.status === 200 && res.body?.items ? res.body.items : []

  return (
    <>
      <h1>Inbox</h1>
      <AutoRefresh intervalMs={15000} action={refreshInboxAction} />

      {items.length === 0 ? (
        <div className="card">
          <p className="muted">
            Todavía no hay conversaciones. Cuando vincules tu WhatsApp en la sección anterior, los
            chats entrantes aparecen aquí.
          </p>
        </div>
      ) : (
        <div className="inbox-list">
          {items.map((item) => (
            <Link key={item.id} href={`/inbox/${item.id}`} className="inbox-row">
              <span className="inbox-main">
                <span className="inbox-name">
                  {item.name}
                  {item.waJid.endsWith('@lid') ? <span className="badge badge-suspended">sin número</span> : null}
                </span>
                <span className="inbox-preview">{preview(item)}</span>
              </span>
              <span className="inbox-side">
                <span className="inbox-time">{formatDateTime(item.lastMessageAt)}</span>
                {item.unread > 0 ? <span className="unread-badge">{item.unread}</span> : null}
              </span>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
