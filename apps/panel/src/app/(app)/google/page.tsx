import Link from 'next/link'
import { apiFetch } from '@/lib/api'
import { formatDateTime } from '@/lib/dates'
import { createEventsAction, disconnectGoogleAction, importBirthdaysAction } from './actions'

/**
 * Vinculación de Google. Sin credenciales en el servidor la sección se ve
 * deshabilitada con el motivo (no una página rota). El botón de vincular es
 * un link a la URL de consentimiento que firma la API en cada render: el
 * state del OAuth vive 10 minutos y la página es dinámica.
 */

export const dynamic = 'force-dynamic'

interface GoogleStatus {
  configured: boolean
  connected: boolean
  googleEmail: string | null
  connectedAt: string | null
}

export default async function GooglePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  const statusRes = await apiFetch<GoogleStatus>('GET', '/google/status')
  const status: GoogleStatus =
    statusRes.status === 200
      ? statusRes.body
      : { configured: false, connected: false, googleEmail: null, connectedAt: null }

  if (!status.configured) {
    return (
      <>
        <h1>Google</h1>
        <div className="card">
          <h2>Sección deshabilitada</h2>
          <p className="muted">
            Este servidor no tiene las credenciales de Google (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
            y GOOGLE_REDIRECT_URI, más ENCRYPTION_KEY para guardar los tokens). Pedirlas al
            administrador.
          </p>
        </div>
      </>
    )
  }

  if (!status.connected) {
    const connectRes = await apiFetch<{ url: string }>('GET', '/google/connect')
    return (
      <>
        <h1>Google</h1>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="card">
          <h2>Cuenta no vinculada</h2>
          <p>
            Vincula tu cuenta de Google para importar los cumpleaños de tus contactos y crearlos
            como eventos anuales en tu calendario. Solo se piden permisos de lectura de contactos,
            de eventos de calendario y del correo de la cuenta.
          </p>
          {connectRes.status === 200 ? (
            <a className="btn btn-primary" href={connectRes.body.url}>
              Vincular Google
            </a>
          ) : (
            <p className="form-error">
              {(connectRes.body as { error?: string })?.error ?? 'no se pudo iniciar la vinculación'}
            </p>
          )}
        </div>
      </>
    )
  }

  return (
    <>
      <h1>Google</h1>
      {error ? <div className="form-error">{error}</div> : null}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginBottom: 0 }}>Cuenta vinculada</h2>
          <span className="badge badge-approved">conectada</span>
        </div>
        <p>
          <strong>{status.googleEmail}</strong>
          {status.connectedAt ? <span className="muted"> desde {formatDateTime(status.connectedAt)}</span> : null}
        </p>
        <div className="row">
          <form action={importBirthdaysAction}>
            <button type="submit" className="btn btn-primary">
              Importar cumpleaños
            </button>
          </form>
          <form action={createEventsAction}>
            <button type="submit" className="btn">
              Crear eventos en Calendar
            </button>
          </form>
          <form action={disconnectGoogleAction}>
            <button type="submit" className="btn btn-danger">
              Desvincular
            </button>
          </form>
        </div>
        <p className="muted">
          Importar trae los cumpleaños de Google Contacts cruzando por teléfono y nunca pisa los que
          editaste a mano. Crear eventos genera, por cada contacto con cumpleaños, un evento anual
          en tu calendario con recordatorio un día antes. El avance de ambos se sigue en{' '}
          <Link href="/tareas">Tareas</Link>.
        </p>
      </div>

      <div className="card">
        <h3>Al desvincular</h3>
        <p className="muted">
          Se revoca el acceso en Google y se borra el refresh token del servidor. Los eventos que ya
          se crearon quedan en tu calendario; puedes borrarlos ahí mismo.
        </p>
      </div>
    </>
  )
}
