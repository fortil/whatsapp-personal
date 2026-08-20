import { apiFetch, getMe, type Me } from '@/lib/api'
import { formatDateTime } from '@/lib/dates'
import { STATUS_LABEL, badgeClass } from '@/lib/labels'
import { EmailForm, PasswordForm } from './CuentaForms'
import { revokeDeviceAction } from './actions'

interface Device {
  id: string
  userAgent: string | null
  lastUsedAt: string | null
  expiresAt: string
}

export default async function CuentaPage() {
  const me = (await getMe()) as Me
  const devicesRes = await apiFetch<Device[]>('GET', '/auth/devices')
  const devices = devicesRes.status === 200 ? devicesRes.body : []

  return (
    <>
      <h1>Cuenta</h1>

      <div className="card">
        <h2>Tus datos</h2>
        <dl className="kv">
          <dt>Correo</dt>
          <dd>{me.email}</dd>
          <dt>Celular</dt>
          <dd>{me.phone}</dd>
          <dt>Rol</dt>
          <dd>{me.role === 'admin' ? 'administrador' : 'usuario'}</dd>
          <dt>Estado</dt>
          <dd>
            <span className={`badge ${badgeClass(me.status)}`}>{STATUS_LABEL[me.status] ?? me.status}</span>
          </dd>
        </dl>
      </div>

      <div className="card">
        <h2>Cambiar contraseña</h2>
        <PasswordForm />
      </div>

      <div className="card">
        <h2>Cambiar correo</h2>
        <EmailForm />
      </div>

      <div className="card">
        <h2>Dispositivos de confianza</h2>
        {devices.length === 0 ? (
          <p className="muted">
            Ninguno. Marca &quot;confiar en este dispositivo&quot; al entrar para saltarte el código
            durante 30 días.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dispositivo</th>
                  <th>Último uso</th>
                  <th>Vence</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id}>
                    <td className="muted">{d.userAgent ?? 'desconocido'}</td>
                    <td>{formatDateTime(d.lastUsedAt)}</td>
                    <td>{formatDateTime(d.expiresAt)}</td>
                    <td>
                      <form action={revokeDeviceAction}>
                        <input type="hidden" name="id" value={d.id} />
                        <button type="submit" className="btn btn-sm btn-danger">
                          Revocar
                        </button>
                      </form>
                    </td>
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
