import Link from 'next/link'
import { redirect } from 'next/navigation'
import { apiFetch, clearPanelCookies, getMe, setMetaCookie } from '@/lib/api'

async function refreshMetaAction(): Promise<void> {
  'use server'
  const me = await getMe()
  if (me) await setMetaCookie(me)
  redirect('/pendiente')
}

async function logoutAction(): Promise<void> {
  'use server'
  await apiFetch('POST', '/auth/logout')
  await clearPanelCookies()
  redirect('/login')
}

/** Estado de la cuenta según /auth/me (la cookie meta solo es un hint). */
export default async function PendientePage() {
  let me = null
  try {
    me = await getMe()
  } catch {
    // API abajo: mostramos el estado neutro
  }
  if (!me) redirect('/login')

  let titulo = 'Esperando aprobación'
  let texto = 'Completaste el registro. William revisa las cuentas nuevas antes de dar acceso; suele tardar poco.'
  if (me.status === 'pending_verification') {
    titulo = 'Falta verificar tu cuenta'
    texto = 'Tu correo o tu celular quedaron sin verificar.'
  } else if (me.status === 'suspended') {
    titulo = 'Cuenta suspendida'
    texto = 'Un administrador suspendió esta cuenta. Escríbele para reactivarla.'
  } else if (me.status === 'rejected') {
    titulo = 'Cuenta rechazada'
    texto = 'Un administrador rechazó este registro.'
  } else if (me.status === 'approved') {
    redirect('/inicio')
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">WhatsApp Personal</div>
        <h1>{titulo}</h1>
        <p className="auth-hint">{texto}</p>
        <div className="row">
          {me.status === 'pending_verification' ? (
            <Link href="/verificar" className="btn btn-primary">
              Continuar verificación
            </Link>
          ) : null}
          <form action={refreshMetaAction}>
            <button type="submit" className="btn">
              Refrescar estado
            </button>
          </form>
          <form action={logoutAction}>
            <button type="submit" className="btn">
              Cerrar sesión
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
