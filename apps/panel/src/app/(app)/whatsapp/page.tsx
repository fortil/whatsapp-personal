import { apiFetch } from '@/lib/api'
import type { ChannelState } from './actions'
import WhatsappConnect from './WhatsappConnect'

/**
 * Vinculación del canal. El estado inicial sale de /channel/sync en el
 * server; el componente cliente sigue consultando cada 5 s.
 */

export const dynamic = 'force-dynamic'

export default async function WhatsappPage() {
  const res = await apiFetch<ChannelState>('POST', '/channel/sync')
  const initial: ChannelState =
    res.status === 200 ? res.body : { error: (res.body as { error?: string })?.error ?? 'no se pudo consultar el canal' }

  return (
    <>
      <h1>WhatsApp</h1>
      <WhatsappConnect initial={initial} />
      <p className="muted">El estado se actualiza solo cada 5 segundos mientras esta pestaña está visible.</p>
    </>
  )
}
