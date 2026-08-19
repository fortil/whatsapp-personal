import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { birthdayEvents, contacts, getDb, googleAccounts, taskRuns, type Db } from '@wp/db'
import { decryptSecret, getEvent, insertAllDayEvent, refreshAccessToken } from '@wp/google'
import type { GoogleJobConfig } from './birthday-import.js'

/**
 * Job birthday_calendar_sync: por cada contacto canónico con cumpleaños,
 * crea en el calendario primary un evento anual all-day y lo reconcilia en
 * corridas siguientes. El evento viaja con FECHA PURA (start.date/end.date,
 * sin dateTime ni timeZone): el servidor va a estar en Singapur (UTC+8), los
 * usuarios en Colombia (UTC-5), y con un timestamp el cumpleaños se correría
 * un día según quién lo mire. La próxima ocurrencia se calcula con el reloj
 * de Bogotá, no el del servidor.
 *
 * Reconciliación: si events.get da 404 o el evento quedó cancelled (el usuario
 * lo borró en Calendar), se recrea y se actualiza google_event_id; en todo
 * caso se refresca last_verified_at. El unique (user_id, contact_id) hace el
 * conjunto idempotente: re-ejecutar no duplica eventos.
 */

export interface BirthdayCalendarSyncDeps {
  db?: Db
  google: GoogleJobConfig | null
  fetch?: typeof fetch
  /** Reloj inyectable para tests de próxima ocurrencia; en producción, now(). */
  now?: () => Date
}

export interface BirthdayCalendarSyncResult {
  candidates: number
  created: number
  recreated: number
  verified: number
}

export interface Occurrence {
  year: number
  month: number
  day: number
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * Próxima ocurrencia del cumpleaños vista desde Bogotá (UTC-5). Feb 29 busca
 * el próximo bisiesto: la recurrencia anual de Google sobre un Feb 29 solo
 * dispara en bisiestos, que es el cumpleaños real de quien lo tiene.
 */
export function nextBirthdayOccurrence(month: number, day: number, now: Date = new Date()): Occurrence {
  // en-CA formatea YYYY-MM-DD: el reloj de Bogotá, no el TZ del servidor
  const bogota = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const [todayY, todayM, todayD] = bogota.split('-').map(Number) as [number, number, number]

  let year = todayY
  if (month < todayM || (month === todayM && day < todayD)) year += 1
  if (month === 2 && day === 29) {
    while (!isLeap(year)) year += 1
  }
  return { year, month, day }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** YYYY-MM-DD de la próxima ocurrencia y el día exclusivo siguiente. */
export function occurrenceDates(occurrence: Occurrence): { startDate: string; endDate: string } {
  const { year, month, day } = occurrence
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  return {
    startDate: `${year}-${pad(month)}-${pad(day)}`,
    endDate: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`,
  }
}

function contactDisplayName(contact: typeof contacts.$inferSelect): string {
  return contact.displayName ?? contact.waName ?? contact.waJid.split('@')[0] ?? contact.waJid
}

export async function runBirthdayCalendarSync(
  userId: string,
  taskRunId: string | null,
  deps: BirthdayCalendarSyncDeps,
): Promise<BirthdayCalendarSyncResult> {
  const db = deps.db ?? getDb()
  if (!deps.google) {
    throw new Error('falta la configuración de Google en el worker (GOOGLE_CLIENT_ID/SECRET y ENCRYPTION_KEY)')
  }

  const account = (
    await db.select().from(googleAccounts).where(eq(googleAccounts.userId, userId)).limit(1)
  )[0]
  if (!account) throw new Error('el usuario no tiene cuenta de Google vinculada')

  const touch = (processed: number, total: number) =>
    taskRunId
      ? db
          .update(taskRuns)
          .set({ status: 'running', processed, total, updatedAt: new Date() })
          .where(eq(taskRuns.id, taskRunId))
      : Promise.resolve()

  try {
    await touch(0, 0)

    const refreshToken = decryptSecret(deps.google.encryptionKey, account.refreshTokenEnc)
    const { accessToken } = await refreshAccessToken(deps.google, refreshToken, { fetch: deps.fetch })

    const withBirthday = await db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.userId, userId),
          isNull(contacts.mergedIntoContactId),
          isNotNull(contacts.birthMonth),
          isNotNull(contacts.birthDay),
        ),
      )
    await touch(0, withBirthday.length)

    const now = deps.now ?? (() => new Date())

    let created = 0
    let recreated = 0
    let verified = 0

    for (const [index, contact] of withBirthday.entries()) {
      const existing = (
        await db
          .select()
          .from(birthdayEvents)
          .where(and(eq(birthdayEvents.userId, userId), eq(birthdayEvents.contactId, contact.id)))
          .limit(1)
      )[0]

      if (existing?.googleEventId) {
        const event = await getEvent(accessToken, existing.googleEventId, { fetch: deps.fetch })
        if (event && event.status !== 'cancelled') {
          await db
            .update(birthdayEvents)
            .set({ lastVerifiedAt: new Date() })
            .where(eq(birthdayEvents.id, existing.id))
          verified += 1
        } else {
          // 404 o cancelled: el usuario lo borró en Calendar, se recrea
          const { startDate, endDate } = occurrenceDates(
            nextBirthdayOccurrence(contact.birthMonth!, contact.birthDay!, now()),
          )
          const event = await insertAllDayEvent(
            accessToken,
            { summary: `Cumpleaños de ${contactDisplayName(contact)}`, startDate, endDate },
            { fetch: deps.fetch },
          )
          await db
            .update(birthdayEvents)
            .set({ googleEventId: event.id, lastVerifiedAt: new Date() })
            .where(eq(birthdayEvents.id, existing.id))
          recreated += 1
        }
      } else {
        const { startDate, endDate } = occurrenceDates(
          nextBirthdayOccurrence(contact.birthMonth!, contact.birthDay!, now()),
        )
        const event = await insertAllDayEvent(
          accessToken,
          { summary: `Cumpleaños de ${contactDisplayName(contact)}`, startDate, endDate },
          { fetch: deps.fetch },
        )
        await db
          .insert(birthdayEvents)
          .values({
            userId,
            contactId: contact.id,
            googleEventId: event.id,
            calendarId: 'primary',
            lastVerifiedAt: new Date(),
          })
          // la carrera con un re-run del mismo job no debe duplicar: gana el
          // primer google_event_id insertado
          .onConflictDoUpdate({
            target: [birthdayEvents.userId, birthdayEvents.contactId],
            set: { googleEventId: event.id, lastVerifiedAt: new Date() },
          })
        created += 1
      }
      await touch(index + 1, withBirthday.length)
    }

    if (taskRunId) {
      await db
        .update(taskRuns)
        .set({
          status: 'done',
          processed: withBirthday.length,
          total: withBirthday.length,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(taskRuns.id, taskRunId))
    }

    return { candidates: withBirthday.length, created, recreated, verified }
  } catch (err) {
    if (taskRunId) {
      await db
        .update(taskRuns)
        .set({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(taskRuns.id, taskRunId))
    }
    throw err
  }
}
