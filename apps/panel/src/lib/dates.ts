/**
 * Render de fechas SIEMPRE en America/Bogota, sin importir la TZ del servidor
 * (en prod es Singapur, UTC+8). Todo render de fecha del panel pasa por aquí.
 */

const BOGOTA = 'America/Bogota'

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value))
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BOGOTA,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(value))
}
