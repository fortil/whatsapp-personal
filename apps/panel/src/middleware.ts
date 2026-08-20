import { NextResponse, type NextRequest } from 'next/server'

/**
 * Solo hints de navegación con la cookie meta {role, status}. La seguridad
 * vive en la API y en los layouts (que validan contra /auth/me server-side):
 * editar esta cookie a mano no muestra ningún contenido protegido.
 */

const AUTH_PAGES = ['/login', '/registro', '/verificar', '/recuperar']
const APP_PREFIXES = ['/inicio', '/cuenta', '/whatsapp', '/inbox', '/contactos', '/tareas', '/google']

interface Meta {
  role?: string
  status?: string
}

function readMeta(req: NextRequest): Meta {
  const raw = req.cookies.get('wp_meta')?.value
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Meta
  } catch {
    return {}
  }
}

export function middleware(req: NextRequest) {
  const meta = readMeta(req)
  const { pathname } = req.nextUrl

  if (pathname.startsWith('/admin') && meta.role !== 'admin') {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  if (APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    if (!meta.status) return NextResponse.redirect(new URL('/login', req.url))
    if (meta.status === 'pending_verification') return NextResponse.redirect(new URL('/verificar', req.url))
    if (meta.status !== 'approved') return NextResponse.redirect(new URL('/pendiente', req.url))
  }

  if (AUTH_PAGES.includes(pathname) && meta.status === 'approved') {
    return NextResponse.redirect(new URL(meta.role === 'admin' ? '/admin' : '/inicio', req.url))
  }

  if (pathname === '/pendiente' && !meta.status) {
    return NextResponse.redirect(new URL('/login', req.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/login',
    '/registro',
    '/verificar',
    '/recuperar',
    '/pendiente',
    '/admin/:path*',
    '/inicio/:path*',
    '/cuenta/:path*',
  ],
}
