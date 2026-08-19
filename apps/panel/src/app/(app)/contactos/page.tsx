import Link from 'next/link'
import { apiFetch } from '@/lib/api'
import { exportContactsAction, summarizeContactAction, syncContactsAction, updateBirthdayAction } from './actions'

/**
 * Tabla de contactos canónicos (merge LID resuelto en la API). Cumpleaños se
 * edita inline; Sincronizar y Exportar encolan tareas del worker y su avance
 * se sigue en /tareas. El resumen por fila no se muestra aquí: solo se
 * dispara, la /tareas es la que informa cuándo terminó.
 */

export const dynamic = 'force-dynamic'

interface ContactItem {
  id: string
  waJid: string
  phoneE164: string | null
  isLid: boolean
  displayName: string | null
  waName: string | null
  birthMonth: number | null
  birthDay: number | null
  birthYear: number | null
  birthdaySource: string | null
}

function contactName(c: ContactItem): string {
  return c.displayName ?? c.waName ?? c.waJid.split('@')[0] ?? c.waJid
}

export default async function ContactosPage({
  searchParams,
}: {
  searchParams: Promise<{ query?: string; cursor?: string }>
}) {
  const { query = '', cursor } = await searchParams
  const qs = new URLSearchParams()
  if (query) qs.set('query', query)
  if (cursor) qs.set('cursor', cursor)

  const res = await apiFetch<{ items: ContactItem[]; nextCursor: string | null }>(
    'GET',
    `/contacts${qs.toString() ? `?${qs}` : ''}`,
  )
  const items = res.status === 200 ? res.body.items : []
  const nextCursor = res.status === 200 ? res.body.nextCursor : null

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ marginBottom: 0 }}>Contactos</h1>
        <div className="row">
          <form action={syncContactsAction}>
            <button type="submit" className="btn btn-sm">
              Sincronizar
            </button>
          </form>
          <form action={exportContactsAction} className="row" style={{ gap: 8 }}>
            <label className="check" style={{ minHeight: 'auto' }}>
              <input type="checkbox" name="includeSummaries" />
              Incluir resúmenes
            </label>
            <button type="submit" className="btn btn-primary btn-sm">
              Exportar a Excel
            </button>
          </form>
        </div>
      </div>

      <form className="card" method="get">
        <div className="field">
          <label htmlFor="query">Buscar por nombre o teléfono</label>
          <input id="query" name="query" defaultValue={query} placeholder="María, +57300…" />
        </div>
        <button type="submit" className="btn btn-sm">
          Buscar
        </button>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Teléfono</th>
              <th>Cumpleaños</th>
              <th>Resumen</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>
                  {contactName(c)}
                  {c.isLid && !c.phoneE164 ? <span className="badge badge-suspended"> sin número</span> : null}
                </td>
                <td>{c.phoneE164 ?? '—'}</td>
                <td>
                  <form action={updateBirthdayAction} className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                    <input type="hidden" name="id" value={c.id} />
                    <input
                      type="number"
                      name="birthMonth"
                      min={1}
                      max={12}
                      placeholder="MM"
                      defaultValue={c.birthMonth ?? ''}
                      style={{ width: 56 }}
                      aria-label="Mes de cumpleaños"
                    />
                    <input
                      type="number"
                      name="birthDay"
                      min={1}
                      max={31}
                      placeholder="DD"
                      defaultValue={c.birthDay ?? ''}
                      style={{ width: 56 }}
                      aria-label="Día de cumpleaños"
                    />
                    <input
                      type="number"
                      name="birthYear"
                      placeholder="AAAA"
                      defaultValue={c.birthYear ?? ''}
                      style={{ width: 76 }}
                      aria-label="Año de cumpleaños"
                    />
                    <button type="submit" className="btn btn-sm">
                      Guardar
                    </button>
                  </form>
                </td>
                <td>
                  <form action={summarizeContactAction}>
                    <input type="hidden" name="id" value={c.id} />
                    <button type="submit" className="btn btn-sm">
                      Resumir
                    </button>
                  </form>
                </td>
              </tr>
            ))}
            {items.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  Todavía no hay contactos. Sincroniza para traerlos de WhatsApp.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {nextCursor ? (
        <p>
          <Link href={`/contactos?${new URLSearchParams({ ...(query ? { query } : {}), cursor: nextCursor })}`}>
            Ver más
          </Link>
        </p>
      ) : null}

      <p className="muted">
        El progreso de sincronizar, exportar y resumir se sigue en <Link href="/tareas">Tareas</Link>.
      </p>
    </>
  )
}
