'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Solo la marca de activo necesita el pathname (client); el shell que la
 * envuelve es server component y valida la sesión.
 */

interface NavLink {
  href: string
  label: string
  disabled?: boolean
}

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export default function ShellNav({ appLinks, adminLinks }: { appLinks: NavLink[]; adminLinks: NavLink[] }) {
  const pathname = usePathname()
  return (
    <nav className="shell-nav">
      {appLinks.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={`${isActive(pathname, l.href) ? 'active' : ''} ${l.disabled ? 'disabled' : ''}`}
          title={l.disabled ? 'Disponible en una fase próxima' : undefined}
        >
          {l.label}
        </Link>
      ))}
      {adminLinks.length > 0 && (
        <>
          <div className="shell-section">Administración</div>
          {adminLinks.map((l) => (
            <Link key={l.href} href={l.href} className={isActive(pathname, l.href) ? 'active' : ''}>
              {l.label}
            </Link>
          ))}
        </>
      )}
    </nav>
  )
}
