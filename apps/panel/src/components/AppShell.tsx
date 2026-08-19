import { redirect } from 'next/navigation'
import { apiFetch, clearPanelCookies, type Me } from '@/lib/api'
import ShellNav from './ShellNav'

/**
 * Shell de la app: sidebar oscuro en escritorio, drawer con overlay < 1024px
 * (checkbox CSS, sin JS de cliente). El logout cierra la sesión en la API
 * antes de limpiar las cookies del panel.
 */

const APP_LINKS = [
  { href: '/inicio', label: 'Inicio' },
  { href: '/whatsapp', label: 'WhatsApp' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/contactos', label: 'Contactos', disabled: true },
  { href: '/tareas', label: 'Tareas', disabled: true },
  { href: '/google', label: 'Google', disabled: true },
  { href: '/cuenta', label: 'Cuenta' },
]

const ADMIN_LINKS = [
  { href: '/admin', label: 'Resumen' },
  { href: '/admin/usuarios', label: 'Usuarios' },
]

export async function logoutAction(): Promise<void> {
  'use server'
  await apiFetch('POST', '/auth/logout')
  await clearPanelCookies()
  redirect('/login')
}

export default async function AppShell({
  children,
  variant,
  me,
}: {
  children: React.ReactNode
  variant: 'app' | 'admin'
  /** Sesión ya validada contra /auth/me por el layout: no se consulta dos veces. */
  me: Me
}) {
  return (
    <div className="shell">
      <input type="checkbox" id="nav-toggle" className="nav-toggle" aria-hidden="true" />

      <aside className="shell-sidebar">
        <div className="shell-brand">WhatsApp Personal</div>
        {variant === 'app' ? (
          <ShellNav appLinks={APP_LINKS} adminLinks={me.role === 'admin' ? ADMIN_LINKS : []} />
        ) : (
          <ShellNav
            appLinks={[{ href: '/inicio', label: '← Volver a la app' }]}
            adminLinks={ADMIN_LINKS}
          />
        )}
        <div className="shell-user">
          <span className="who">{me.email}</span>
          <form action={logoutAction}>
            <button type="submit" className="btn btn-sm">
              Cerrar sesión
            </button>
          </form>
        </div>
      </aside>

      <label htmlFor="nav-toggle" className="nav-overlay" aria-label="Cerrar menú" />

      <main className="shell-main">
        <div className="shell-topbar">
          <label htmlFor="nav-toggle" className="nav-toggle-label" aria-label="Abrir menú">
            <span />
            <span />
            <span />
          </label>
          <span className="shell-brand" style={{ color: '#fff', padding: 0 }}>
            WhatsApp Personal
          </span>
        </div>
        {children}
      </main>
    </div>
  )
}
