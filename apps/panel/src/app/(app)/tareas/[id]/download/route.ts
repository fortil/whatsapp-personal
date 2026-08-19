import { cookies, headers } from 'next/headers'
import { API_URL } from '@/lib/api'

/**
 * Proxy de la descarga: el navegador nunca llama a la API directamente (regla
 * del proyecto), así que este route handler reenvía la cookie de sesión del
 * panel y transmite el binario tal cual. Sin sesión válida o sin acceso al
 * archivo, la API responde 401/404 y aquí se replica igual.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const cookieJar = await cookies()
  const requestHeaders = await headers()
  const forwardedFor = requestHeaders.get('x-forwarded-for')

  const res = await fetch(`${API_URL}/tasks/${id}/download`, {
    headers: {
      ...(cookieJar.toString() ? { cookie: cookieJar.toString() } : {}),
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
    cache: 'no-store',
  })

  if (!res.ok || !res.body) {
    let error = 'no se pudo descargar el archivo'
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) error = body.error
    } catch {
      // respuesta sin JSON: se queda el mensaje genérico
    }
    return new Response(JSON.stringify({ error }), {
      status: res.status || 502,
      headers: { 'content-type': 'application/json' },
    })
  }

  return new Response(res.body, {
    status: 200,
    headers: {
      'content-type':
        res.headers.get('content-type') ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': res.headers.get('content-disposition') ?? `attachment; filename="tarea-${id}.xlsx"`,
    },
  })
}
