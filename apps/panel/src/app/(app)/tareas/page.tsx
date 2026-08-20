import AutoRefresh from '@/components/AutoRefresh'
import { apiFetch } from '@/lib/api'
import { formatDateTime } from '@/lib/dates'
import { TASK_KIND_LABEL, TASK_STATUS_LABEL, taskStatusBadgeClass } from '@/lib/labels'
import { refreshTasksAction } from './actions'

/**
 * Lista de task_runs del usuario con progreso real y descarga cuando hay
 * archivo. Poll de 5 s (mismo patrón que /inbox) mientras la pestaña está
 * visible: sync/resumen/export corren en el worker, no aquí.
 */

export const dynamic = 'force-dynamic'

interface TaskItem {
  id: string
  kind: string
  status: string
  processed: number
  total: number
  error: string | null
  hasFile: boolean
  updatedAt: string
  finishedAt: string | null
}

function progressPct(t: TaskItem): number {
  if (t.total <= 0) return t.status === 'done' ? 100 : 0
  return Math.min(100, Math.round((t.processed / t.total) * 100))
}

export default async function TareasPage() {
  const res = await apiFetch<{ items: TaskItem[] }>('GET', '/tasks')
  const items = res.status === 200 ? res.body.items : []

  return (
    <>
      <h1>Tareas</h1>
      <AutoRefresh intervalMs={5000} action={refreshTasksAction} />
      <p className="muted">Se actualiza sola cada 5 segundos mientras esta pestaña está visible.</p>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Estado</th>
              <th>Progreso</th>
              <th>Actualizada</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <tr key={t.id}>
                <td>{TASK_KIND_LABEL[t.kind] ?? t.kind}</td>
                <td>
                  <span className={`badge ${taskStatusBadgeClass(t.status)}`}>
                    {TASK_STATUS_LABEL[t.status] ?? t.status}
                  </span>
                  {t.status === 'error' && t.error ? <p className="muted">{t.error}</p> : null}
                </td>
                <td>
                  <div className="progress">
                    <div className="progress-bar" style={{ width: `${progressPct(t)}%` }} />
                  </div>
                  <span className="muted">
                    {t.processed}/{t.total}
                  </span>
                </td>
                <td>{formatDateTime(t.updatedAt)}</td>
                <td>
                  {t.status === 'done' && t.hasFile ? (
                    <a className="btn btn-sm" href={`/tareas/${t.id}/download`}>
                      Descargar
                    </a>
                  ) : null}
                </td>
              </tr>
            ))}
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  Todavía no hay tareas. Sincroniza o exporta contactos desde esa sección.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  )
}
