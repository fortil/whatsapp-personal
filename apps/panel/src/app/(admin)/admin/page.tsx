import { apiFetch } from '@/lib/api'
import { formatDateTime } from '@/lib/dates'

interface Overview {
  usersByStatus: Array<{ status: string; count: number }>
  instancesByState: Array<{ state: string; count: number }>
  failedTasksLast24h: Array<{ id: string; kind: string; error: string | null; updatedAt: string }>
}

const STATUS_LABEL: Record<string, string> = {
  pending_verification: 'por verificar',
  pending_approval: 'por aprobar',
  approved: 'aprobadas',
  rejected: 'rechazadas',
  suspended: 'suspendidas',
}

export default async function AdminOverviewPage() {
  const res = await apiFetch<Overview>('GET', '/admin/overview')
  const overview = res.status === 200 ? res.body : { usersByStatus: [], instancesByState: [], failedTasksLast24h: [] }

  return (
    <>
      <h1>Administración</h1>

      <div className="card">
        <h2>Cuentas por estado</h2>
        <div className="stats-grid">
          {overview.usersByStatus.length === 0 ? <p className="muted">Sin usuarios todavía.</p> : null}
          {overview.usersByStatus.map((s) => (
            <div key={s.status} className="stat">
              <span className="n">{s.count}</span>
              <span className="l">{STATUS_LABEL[s.status] ?? s.status}</span>
            </div>
          ))}
        </div>
        {overview.usersByStatus.some((s) => s.status === 'pending_approval') ? (
          <p style={{ marginTop: 12 }}>
            Hay cuentas esperando aprobación en <a href="/admin/usuarios?status=pending_approval">Usuarios</a>.
          </p>
        ) : null}
      </div>

      <div className="card">
        <h2>Instancias de WhatsApp</h2>
        {overview.instancesByState.length === 0 ? (
          <p className="muted">Ninguna todavía; la vinculación llega en la fase 2.</p>
        ) : (
          <div className="stats-grid">
            {overview.instancesByState.map((s) => (
              <div key={s.state} className="stat">
                <span className="n">{s.count}</span>
                <span className="l">{s.state}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Tareas fallidas (24 h)</h2>
        {overview.failedTasksLast24h.length === 0 ? (
          <p className="muted">Ninguna.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Error</th>
                  <th>Actualizada</th>
                </tr>
              </thead>
              <tbody>
                {overview.failedTasksLast24h.map((t) => (
                  <tr key={t.id}>
                    <td>{t.kind}</td>
                    <td className="muted">{t.error ?? '—'}</td>
                    <td>{formatDateTime(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
