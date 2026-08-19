import { GoogleError } from './error.js'

/**
 * Calendar API v3 con fetch crudo, limitado a lo que usa el job de cumpleaños:
 * insert (evento anual all-day), get (reconciliación) y delete. El evento usa
 * start.date/end.date con FECHA PURA, sin dateTime ni timeZone: el servidor de
 * producción está en Singapur (UTC+8) y los usuarios en Colombia (UTC-5), y un
 * timestamp corría los cumpleaños un día según quién lo mirara.
 */

export const CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3/calendars'

/** Recordatorio popup un día antes, en minutos (all-day: relativo a la medianoche local del que mira). */
export const BIRTHDAY_REMINDER_MINUTES = 24 * 60

export interface CalendarFetchOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface AllDayEventInput {
  summary: string
  /** YYYY-MM-DD de la próxima ocurrencia. */
  startDate: string
  /** YYYY-MM-DD exclusivo: inicio + 1 día para un evento de un día. */
  endDate: string
  reminderMinutesBefore?: number
}

export interface CalendarEventRef {
  id: string
  /** confirmed | cancelled | …; el job recrea cuando el usuario borró el evento. */
  status: string
}

function calendarUrl(calendarId: string, suffix: string): string {
  return `${CALENDAR_BASE_URL}/${encodeURIComponent(calendarId)}${suffix}`
}

async function request(
  method: string,
  url: string,
  accessToken: string,
  opts: { body?: unknown; fetch?: typeof fetch; timeoutMs?: number },
): Promise<Response> {
  const doFetch = opts.fetch ?? fetch
  try {
    return await doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
  } catch (err) {
    throw new GoogleError(`no se pudo hablar con Calendar API: ${err instanceof Error ? err.message : err}`)
  }
}

async function errorDetail(res: Response): Promise<string> {
  const detail = await res.text().catch(() => '')
  return `→ ${res.status} ${detail.slice(0, 200)}`
}

/**
 * Crea el evento anual all-day. recurrence + fecha pura: Google lo repite cada
 * año en esa fecha según el calendario de quien mira, sin TZ del servidor.
 */
export async function insertAllDayEvent(
  accessToken: string,
  event: AllDayEventInput,
  opts: CalendarFetchOptions & { calendarId?: string } = {},
): Promise<CalendarEventRef> {
  const res = await request('POST', calendarUrl(opts.calendarId ?? 'primary', '/events'), accessToken, {
    body: {
      summary: event.summary,
      start: { date: event.startDate },
      end: { date: event.endDate },
      recurrence: ['RRULE:FREQ=YEARLY'],
      reminders: {
        useDefault: false,
        overrides: [{ method: 'popup', minutes: event.reminderMinutesBefore ?? BIRTHDAY_REMINDER_MINUTES }],
      },
    },
    fetch: opts.fetch,
    timeoutMs: opts.timeoutMs,
  })
  if (!res.ok) throw new GoogleError(`events.insert ${errorDetail(res)}`, res.status)
  const json = asRecord(await safeJson(res))
  const id = json.id
  if (typeof id !== 'string' || !id) throw new GoogleError('events.insert no devolvió id')
  return { id, status: typeof json.status === 'string' ? json.status : 'confirmed' }
}

/** El evento según Google; null si ya no existe (404: el usuario lo borró). */
export async function getEvent(
  accessToken: string,
  eventId: string,
  opts: CalendarFetchOptions & { calendarId?: string } = {},
): Promise<CalendarEventRef | null> {
  const res = await request(
    'GET',
    calendarUrl(opts.calendarId ?? 'primary', `/events/${encodeURIComponent(eventId)}`),
    accessToken,
    { fetch: opts.fetch, timeoutMs: opts.timeoutMs },
  )
  if (res.status === 404) return null
  if (!res.ok) throw new GoogleError(`events.get ${errorDetail(res)}`, res.status)
  const json = asRecord(await safeJson(res))
  if (typeof json.id !== 'string' || !json.id) throw new GoogleError('events.get no devolvió id')
  return { id: json.id, status: typeof json.status === 'string' ? json.status : 'confirmed' }
}

/** Borra el evento; 404 cuenta como borrado. */
export async function deleteEvent(
  accessToken: string,
  eventId: string,
  opts: CalendarFetchOptions & { calendarId?: string } = {},
): Promise<void> {
  const res = await request(
    'DELETE',
    calendarUrl(opts.calendarId ?? 'primary', `/events/${encodeURIComponent(eventId)}`),
    accessToken,
    { fetch: opts.fetch, timeoutMs: opts.timeoutMs },
  )
  if (res.ok || res.status === 404) return
  throw new GoogleError(`events.delete ${errorDetail(res)}`, res.status)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text())
  } catch {
    throw new GoogleError('Calendar API → respuesta no es JSON')
  }
}
