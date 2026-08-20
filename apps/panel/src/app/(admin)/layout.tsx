import { redirect } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { getMe } from '@/lib/api'

/**
 * El shell del admin se valida contra /auth/me en el server: exige rol admin
 * Y estado approved leídos de la DB. Flipear la cookie meta no basta.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let me = null
  try {
    me = await getMe()
  } catch {
    // API abajo: no hay sesión comprobable
  }
  if (!me) redirect('/login')
  if (me.role !== 'admin' || me.status !== 'approved') redirect('/inicio')

  return (
    <AppShell variant="admin" me={me}>
      {children}
    </AppShell>
  )
}
