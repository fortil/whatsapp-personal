import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { birthdayEvents, closeClient, contacts, getDb, googleAccounts, users, type Db } from '@wp/db'
import { encryptSecret } from '@wp/google'
import {
  nextBirthdayOccurrence,
  occurrenceDates,
  runBirthdayCalendarSync,
} from './birthday-calendar-sync.js'

/**
 * birthday_calendar_sync contra el postgres real, con dobles del fetch para
 * Calendar. El contrato duro: evento all-day con FECHA PURA en la próxima
 * ocurrencia vista desde Bogotá (no la TZ del servidor), reconciliación cuando
 * el usuario borró el evento, e idempotencia por (user_id, contact_id).
 */

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`
const ENC_KEY = '7d'.repeat(32)
const GOOGLE = { clientId: 'cid', clientSecret: 'csec', encryptionKey: ENC_KEY }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// secuencia global: los ids de eventos insertados nunca se repiten entre
// corridas, para poder afirmar que una reconciliación realmente actualizó
// google_event_id
let seq = 0

/**
 * Doble del fetch de Calendar. getMode decide qué responde events.get por
 * corrida: 'ok' (confirmado), 'missing' (404) o 'cancelled'. Los inserts se
 * graban con su cuerpo para inspeccionar fecha pura, recurrencia y recordatorio.
 */
function calendarFetch(getMode: 'ok' | 'missing' | 'cancelled' = 'ok') {
  const inserts: Array<{ url: string; body: any }> = []
  const getCalls: string[] = []
  const fake: typeof fetch = async (input: any, init?: any) => {
    const url = input.toString()
    const method = init?.method ?? 'GET'
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return json(200, { access_token: 'ya29.worker', expires_in: 3600 })
    }
    if (method === 'POST') {
      seq += 1
      inserts.push({ url, body: JSON.parse(String(init.body)) })
      return json(200, { id: `evt-${seq}`, status: 'confirmed' })
    }
    if (method === 'GET') {
      const eventId = url.split('/events/')[1] ?? ''
      getCalls.push(eventId)
      if (getMode === 'missing') return json(404, {})
      return json(200, { id: eventId, status: getMode === 'cancelled' ? 'cancelled' : 'confirmed' })
    }
    return json(500, {})
  }
  return { inserts, getCalls, fake }
}

let db: Db
let userId: string
const suiteUserIds: string[] = []

async function insertContact(values: Partial<typeof contacts.$inferInsert> & { waJid: string }) {
  const [row] = await db
    .insert(contacts)
    .values({ userId, displayName: values.waJid.split('@')[0], ...values })
    .returning()
  return row!
}

async function eventRow(contactId: string) {
  return (
    await db.select().from(birthdayEvents).where(eq(birthdayEvents.contactId, contactId)).limit(1)
  )[0]
}

beforeAll(async () => {
  db = getDb()
  const [user] = await db
    .insert(users)
    .values({
      email: `worker-bday-cal.${RUN}@mail.test`,
      phone: `+57308${RUN.slice(-6).padStart(6, '0')}`,
      passwordHash: 'x:y',
      status: 'approved',
    })
    .returning()
  userId = user!.id
  suiteUserIds.push(userId)

  await db.insert(googleAccounts).values({
    userId,
    googleEmail: 'ana@gmail.com',
    refreshTokenEnc: encryptSecret(ENC_KEY, '1//0g.worker-refresh'),
    scopes: 'calendar.events contacts.readonly',
  })

  // 2026-08-19T20:00:00Z son las 15:00 del 19 de agosto en Bogotá
  await insertContact({
    waJid: '573006660001@s.whatsapp.net',
    displayName: 'Mañana',
    phoneE164: '+573006660001',
    birthMonth: 8,
    birthDay: 20,
    birthYear: 1990,
  })
  await insertContact({
    waJid: '573006660002@s.whatsapp.net',
    displayName: 'Hoy',
    phoneE164: '+573006660002',
    birthMonth: 8,
    birthDay: 19,
  })
  await insertContact({
    waJid: '573006660003@s.whatsapp.net',
    displayName: 'Ya Pasó',
    phoneE164: '+573006660003',
    birthMonth: 1,
    birthDay: 2,
    birthYear: 2000,
  })
  await insertContact({
    waJid: '573006660004@s.whatsapp.net',
    displayName: 'Bisiesto',
    phoneE164: '+573006660004',
    birthMonth: 2,
    birthDay: 29,
  })
  // sin cumpleaños: no es candidato
  await insertContact({ waJid: '573006660005@s.whatsapp.net', phoneE164: '+573006660005' })
})

afterAll(async () => {
  await db.delete(birthdayEvents).where(inArray(birthdayEvents.userId, suiteUserIds)).catch(() => {})
  await db.delete(googleAccounts).where(inArray(googleAccounts.userId, suiteUserIds)).catch(() => {})
  await db.delete(contacts).where(inArray(contacts.userId, suiteUserIds)).catch(() => {})
  await db.delete(users).where(inArray(users.id, suiteUserIds)).catch(() => {})
  await closeClient()
})

describe('nextBirthdayOccurrence (reloj de Bogotá)', () => {
  it('cumpleaños todavía no llegado va al año en curso; pasado, al siguiente', () => {
    const now = new Date('2026-08-19T20:00:00Z') // 15:00 en Bogotá
    expect(nextBirthdayOccurrence(8, 20, now)).toEqual({ year: 2026, month: 8, day: 20 })
    expect(nextBirthdayOccurrence(8, 19, now)).toEqual({ year: 2026, month: 8, day: 19 }) // hoy
    expect(nextBirthdayOccurrence(1, 2, now)).toEqual({ year: 2027, month: 1, day: 2 })
    expect(nextBirthdayOccurrence(8, 18, now)).toEqual({ year: 2027, month: 8, day: 18 })
  })

  it('usa el reloj de Bogotá, no la TZ del servidor: 31-dic 20:00Z sigue siendo 31-dic en CO', () => {
    // en UTC ya sería 1 de enero de 2027; en Bogotá siguen en 31-dic-2026
    const now = new Date('2026-12-31T20:00:00Z')
    expect(nextBirthdayOccurrence(1, 1, now)).toEqual({ year: 2027, month: 1, day: 1 })
    // y a las 04:00Z del 1-ene (23:00 del 31-dic en Bogotá), 1-ene sigue siendo próximo
    const lateNight = new Date('2027-01-01T04:00:00Z')
    expect(nextBirthdayOccurrence(1, 1, lateNight)).toEqual({ year: 2027, month: 1, day: 1 })
  })

  it('29 de febrero busca el próximo bisiesto', () => {
    const now = new Date('2026-08-19T20:00:00Z')
    expect(nextBirthdayOccurrence(2, 29, now)).toEqual({ year: 2028, month: 2, day: 29 })
  })

  it('occurrenceDates: end es el día siguiente, fecha pura', () => {
    expect(occurrenceDates({ year: 2027, month: 5, day: 10 })).toEqual({
      startDate: '2027-05-10',
      endDate: '2027-05-11',
    })
    expect(occurrenceDates({ year: 2028, month: 2, day: 29 })).toEqual({
      startDate: '2028-02-29',
      endDate: '2028-03-01',
    })
  })
})

describe('runBirthdayCalendarSync', () => {
  const NOW = () => new Date('2026-08-19T20:00:00Z')

  it('crea eventos all-day con fecha pura, recurrencia anual y recordatorio', async () => {
    const { inserts, fake } = calendarFetch()
    const result = await runBirthdayCalendarSync(userId, null, { db, google: GOOGLE, fetch: fake, now: NOW })

    expect(result).toEqual({ candidates: 4, created: 4, recreated: 0, verified: 0 })
    expect(inserts).toHaveLength(4)

    const bySummary = new Map(inserts.map((i) => [i.body.summary as string, i.body]))
    expect(bySummary.get('Cumpleaños de Mañana')).toMatchObject({
      start: { date: '2026-08-20' },
      end: { date: '2026-08-21' },
      recurrence: ['RRULE:FREQ=YEARLY'],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 1440 }] },
    })
    expect(bySummary.get('Cumpleaños de Hoy')).toMatchObject({ start: { date: '2026-08-19' } })
    expect(bySummary.get('Cumpleaños de Ya Pasó')).toMatchObject({ start: { date: '2027-01-02' } })
    expect(bySummary.get('Cumpleaños de Bisiesto')).toMatchObject({ start: { date: '2028-02-29' } })

    // fecha pura: nada de dateTime ni timeZone en start/end
    for (const insert of inserts) {
      expect(insert.body.start.dateTime).toBeUndefined()
      expect(insert.body.start.timeZone).toBeUndefined()
      expect(insert.body.end.dateTime).toBeUndefined()
      expect(insert.body.end.timeZone).toBeUndefined()
      expect(insert.url).toContain('https://www.googleapis.com/calendar/v3/calendars/primary/events')
    }

    // filas creadas con su google_event_id
    const tomorrow = (await db.select().from(contacts).where(eq(contacts.displayName, 'Mañana')).limit(1))[0]!
    const row = await eventRow(tomorrow.id)
    expect(row?.googleEventId).toMatch(/^evt-[1-4]$/)
    expect(row?.calendarId).toBe('primary')
  })

  it('idempotente: re-ejecutar verifica con events.get y no inserta duplicados', async () => {
    const { inserts, getCalls, fake } = calendarFetch('ok')
    const result = await runBirthdayCalendarSync(userId, null, { db, google: GOOGLE, fetch: fake, now: NOW })

    expect(result).toEqual({ candidates: 4, created: 0, recreated: 0, verified: 4 })
    expect(inserts).toHaveLength(0)
    expect(getCalls).toHaveLength(4)

    const tomorrow = (await db.select().from(contacts).where(eq(contacts.displayName, 'Mañana')).limit(1))[0]!
    const row = await eventRow(tomorrow.id)
    expect(row?.googleEventId).toMatch(/^evt-[1-4]$/) // no cambió
    expect(row?.lastVerifiedAt).not.toBeNull()
  })

  it('evento borrado en Calendar (404): lo recrea y actualiza google_event_id', async () => {
    const { inserts, fake } = calendarFetch('missing')
    const result = await runBirthdayCalendarSync(userId, null, { db, google: GOOGLE, fetch: fake, now: NOW })

    expect(result).toEqual({ candidates: 4, created: 0, recreated: 4, verified: 0 })
    expect(inserts).toHaveLength(4)

    const tomorrow = (await db.select().from(contacts).where(eq(contacts.displayName, 'Mañana')).limit(1))[0]!
    const rows = await db.select().from(birthdayEvents).where(eq(birthdayEvents.contactId, tomorrow.id))
    expect(rows).toHaveLength(1) // el unique (user_id, contact_id) no duplicó
    expect(rows[0]!.googleEventId).toMatch(/^evt-[5-8]$/) // id nuevo, el viejo murió con el evento
  })

  it('evento cancelado: también se recrea', async () => {
    const { inserts, fake } = calendarFetch('cancelled')
    const result = await runBirthdayCalendarSync(userId, null, { db, google: GOOGLE, fetch: fake, now: NOW })
    expect(result).toEqual({ candidates: 4, created: 0, recreated: 4, verified: 0 })
    expect(inserts).toHaveLength(4)
  })

  it('sin configuración de Google en el worker falla con mensaje claro', async () => {
    await expect(runBirthdayCalendarSync(userId, null, { db, google: null, now: NOW })).rejects.toThrow(
      /falta la configuración de Google/,
    )
  })
})
