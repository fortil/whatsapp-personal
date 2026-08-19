import { describe, expect, it } from 'vitest'
import { deleteEvent, getEvent, insertAllDayEvent } from './index.js'

/**
 * Calendar v3 contra dobles del fetch con la forma real. El contrato crítico:
 * el evento de cumpleaños viaja con FECHA PURA (start.date/end.date, sin
 * dateTime ni timeZone) para que el TZ del servidor (Singapur) no lo corra un
 * día frente a Colombia.
 */

interface Recorded {
  url: string
  method: string
  body: unknown
  auth: string | null
}

function recorder(handler: (url: URL) => Response) {
  const calls: Recorded[] = []
  const fake: typeof fetch = (input, init) => {
    const url = new URL(input.toString())
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url: `${url.origin}${url.pathname}`,
      method: init?.method ?? 'GET',
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : null,
      auth: headers['authorization'] ?? null,
    })
    return Promise.resolve(handler(url))
  }
  return { calls, fake }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('insertAllDayEvent', () => {
  it('cuerpo con fecha pura, recurrencia anual y recordatorio 1 día antes', async () => {
    const { calls, fake } = recorder(() => json(200, { id: 'evt-1', status: 'confirmed' }))
    const event = await insertAllDayEvent(
      'ya29.access',
      { summary: 'Cumpleaños de Ana', startDate: '2027-05-10', endDate: '2027-05-11' },
      { fetch: fake },
    )
    expect(event).toEqual({ id: 'evt-1', status: 'confirmed' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    expect(calls[0]!.auth).toBe('Bearer ya29.access')

    const body = calls[0]!.body as Record<string, any>
    expect(body.summary).toBe('Cumpleaños de Ana')
    expect(body.start).toEqual({ date: '2027-05-10' }) // sin dateTime, sin timeZone
    expect(body.end).toEqual({ date: '2027-05-11' })
    expect(body.recurrence).toEqual(['RRULE:FREQ=YEARLY'])
    expect(body.reminders).toEqual({
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 1440 }],
    })
  })

  it('respeta calendarId y reminderMinutesBefore custom', async () => {
    const { calls, fake } = recorder(() => json(200, { id: 'evt-2', status: 'confirmed' }))
    await insertAllDayEvent(
      'ya29.access',
      { summary: 'x', startDate: '2027-01-01', endDate: '2027-01-02', reminderMinutesBefore: 30 },
      { fetch: fake, calendarId: 'cal-9' },
    )
    expect(calls[0]!.url).toContain('/calendars/cal-9/events')
    const body = calls[0]!.body as Record<string, any>
    expect(body.reminders.overrides[0].minutes).toBe(30)
  })
})

describe('getEvent', () => {
  it('404 (el usuario borró el evento) devuelve null', async () => {
    const { fake } = recorder(() => json(404, { error: { code: 404, message: 'Not found' } }))
    await expect(getEvent('ya29.access', 'evt-1', { fetch: fake })).resolves.toBeNull()
  })

  it('evento cancelado llega con su status para que el caller decida recrear', async () => {
    const { calls, fake } = recorder(() => json(200, { id: 'evt-1', status: 'cancelled' }))
    await expect(getEvent('ya29.access', 'evt-1', { fetch: fake })).resolves.toEqual({
      id: 'evt-1',
      status: 'cancelled',
    })
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url).toContain('/events/evt-1')
  })
})

describe('deleteEvent', () => {
  it('204 y 404 resuelven; otro error lanza con status', async () => {
    const ok = recorder(() => new Response(null, { status: 204 }))
    await expect(deleteEvent('ya29.access', 'evt-1', { fetch: ok.fake })).resolves.toBeUndefined()

    const gone = recorder(() => json(404, {}))
    await expect(deleteEvent('ya29.access', 'evt-1', { fetch: gone.fake })).resolves.toBeUndefined()

    const broken = recorder(() => json(500, {}))
    await expect(deleteEvent('ya29.access', 'evt-1', { fetch: broken.fake })).rejects.toMatchObject({
      status: 500,
    })
  })
})
