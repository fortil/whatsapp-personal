import Link from 'next/link'
import { apiFetch } from '@/lib/api'
import { STATUS_LABEL, badgeClass } from '@/lib/labels'
import { correctEmailAction, resetPasswordAction, userAction } from './actions'

interface AdminUser {
  id: string
  email: string
  phone: string
  role: 'user' | 'admin'
  status: 'pending_verification' | 'pending_approval' | 'approved' | 'rejected' | 'suspended'
  emailVerifiedAt: string | null
  phoneVerifiedAt: string | null
  rejectedReason: string | null
}

const FILTERS = [
  { value: '' },
  { value: 'pending_verification' },
  { value: 'pending_approval' },
  { value: 'approved' },
  { value: 'rejected' },
  { value: 'suspended' },
]

const STATUS_LABEL_PLURAL: Record<string, string> = {
  pending_verification: 'Por verificar',
  pending_approval: 'Por aprobar',
  approved: 'Aprobadas',
  rejected: 'Rechazadas',
  suspended: 'Suspendidas',
}

export default async function AdminUsuariosPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const params = await searchParams
  const status = params.status ?? ''
  const res = await apiFetch<AdminUser[]>('GET', `/admin/users${status ? `?status=${status}` : ''}`)
  const users = res.status === 200 ? res.body : []

  return (
    <>
      <h1>Usuarios</h1>

      <div className="card">
        <div className="row">
          {FILTERS.map((f) => (
            <Link
              key={f.value}
              href={f.value ? `/admin/usuarios?status=${f.value}` : '/admin/usuarios'}
              className={`btn btn-sm ${status === f.value ? 'btn-primary' : ''}`}
            >
              {STATUS_LABEL_PLURAL[f.value] ?? 'Todas'}
            </Link>
          ))}
        </div>
      </div>

      {users.length === 0 ? (
        <div className="card">
          <p className="muted">Nada por aquí con este filtro.</p>
        </div>
      ) : (
        users.map((u) => (
          <div className="card" key={u.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>{u.email}</strong>
                {u.role === 'admin' ? <span className="badge badge-admin" style={{ marginLeft: 8 }}>admin</span> : null}
              </div>
              <span className={`badge ${badgeClass(u.status)}`}>{STATUS_LABEL[u.status]}</span>
            </div>
            <p className="muted" style={{ margin: '6px 0 10px' }}>
              {u.phone} · correo {u.emailVerifiedAt ? 'verificado' : 'sin verificar'} · celular{' '}
              {u.phoneVerifiedAt ? 'verificado' : 'sin verificar'}
              {u.rejectedReason ? ` · motivo: ${u.rejectedReason}` : ''}
            </p>
            <div className="row-actions">
              {u.status !== 'approved' && u.status !== 'rejected' ? (
                <form action={userAction}>
                  <input type="hidden" name="id" value={u.id} />
                  <input type="hidden" name="op" value="approve" />
                  <button type="submit" className="btn btn-sm btn-primary">
                    Aprobar
                  </button>
                </form>
              ) : null}
              {u.status !== 'rejected' ? (
                <form action={userAction}>
                  <input type="hidden" name="id" value={u.id} />
                  <input type="hidden" name="op" value="reject" />
                  <button type="submit" className="btn btn-sm btn-danger">
                    Rechazar
                  </button>
                </form>
              ) : null}
              {u.status === 'approved' || u.status === 'suspended' ? (
                <form action={userAction}>
                  <input type="hidden" name="id" value={u.id} />
                  <input type="hidden" name="op" value={u.status === 'approved' ? 'suspend' : 'reinstate'} />
                  <button type="submit" className="btn btn-sm">
                    {u.status === 'approved' ? 'Suspender' : 'Reincorporar'}
                  </button>
                </form>
              ) : null}
              {u.status === 'rejected' ? (
                <form action={userAction}>
                  <input type="hidden" name="id" value={u.id} />
                  <input type="hidden" name="op" value="reinstate" />
                  <button type="submit" className="btn btn-sm">
                    Reincorporar
                  </button>
                </form>
              ) : null}
              <form action={resetPasswordAction}>
                <input type="hidden" name="id" value={u.id} />
                <button type="submit" className="btn btn-sm">
                  Reset contraseña
                </button>
              </form>
            </div>
            <details style={{ marginTop: 10 }}>
              <summary className="muted" style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>
                Corregir correo (typos de registro)
              </summary>
              <form action={correctEmailAction} className="row" style={{ marginTop: 10 }}>
                <input type="hidden" name="id" value={u.id} />
                <input
                  name="email"
                  type="email"
                  defaultValue={u.email}
                  style={{ maxWidth: 280 }}
                  aria-label={`Correo nuevo para ${u.email}`}
                  required
                />
                <button type="submit" className="btn btn-sm">
                  Guardar correo
                </button>
              </form>
              <p className="muted" style={{ marginTop: 8 }}>
                Al corregir, la verificación del correo se revierte: el usuario re-verifica desde /verificar.
              </p>
            </details>
          </div>
        ))
      )}
    </>
  )
}
