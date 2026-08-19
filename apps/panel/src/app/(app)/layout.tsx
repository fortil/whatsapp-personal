import { redirect } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { getMe } from '@/lib/api'

/**
 * La compuerta real de la app: valida contra /auth/me en el server. La cookie
 * meta del middleware es solo un redirect temprano; flipearla no muestra el
 * shell ni sus datos.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let me = null
  try {
    me = await getMe()
  } catch {
    // API abajo: no hay forma de comprobar la sesión
  }
  if (!me) redirect('/login')
  if (me.status === 'pending_verification' || me.status === 'pending_approval') {
    redirect(me.status === 'pending_verification' ? '/verificar' : '/pendiente')
  }
  if (me.status !== 'approved') redirect('/pendiente')

  return (
    <AppShell variant="app" me={me}>
      {children}
    </AppShell>
  )
}
