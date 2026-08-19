import { and, eq, isNull } from 'drizzle-orm'
import { contacts, getDb, googleAccounts, taskRuns, type Db } from '@wp/db'
import { decryptSecret, fetchConnections, refreshAccessToken } from '@wp/google'
import { parseLoosePhone, phoneMatchKey } from '@wp/shared'

/**
 * Job birthday_import: refresca el access token (solo en memoria), recorre
 * people.connections.list, normaliza los teléfonos sucios de Google con
 * parseLoosePhone/phoneMatchKey y cruza contra phone_e164 de los contactos
 * CANÓNICOS (merged_into_contact_id IS NULL). Escribe el cumpleaños con
 * birthday_source='google' salvo que el contacto ya esté en manual: lo manual
 * nunca se pisa. El sync token se persiste para corridas incrementales; el 410
 * (token vencido) ya se resolvió adentro con un resync completo.
 */

/** Config de Google que comparten los dos jobs de cumpleaños. */
export interface GoogleJobConfig {
  clientId: string
  clientSecret: string
  encryptionKey: string
}

export interface BirthdayImportDeps {
  db?: Db
  google: GoogleJobConfig | null
  /** Inyectable para tests; en producción siempre el fetch global. */
  fetch?: typeof fetch
}

export interface BirthdayImportResult {
  people: number
  matched: number
  updated: number
  keptManual: number
  fullResync: boolean
  syncToken: string | null
}

/** Contactos canónicos con teléfono, indexados por E164 exacto y por últimos 10 dígitos. */
async function phoneMaps(db: Db, userId: string) {
  const byExact = new Map<string, string>()
  const byKey = new Map<string, string>()
  const rows = await db
    .select({ id: contacts.id, phoneE164: contacts.phoneE164 })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), isNull(contacts.mergedIntoContactId)))
  for (const row of rows) {
    if (!row.phoneE164) continue
    byExact.set(row.phoneE164, row.id)
    const key = phoneMatchKey(row.phoneE164)
    if (key) byKey.set(key, row.id)
  }
  return { byExact, byKey }
}

/** Los contactos canónicos que matchean cualquier teléfono (sucio) de la persona de Google. */
function matchContacts(personPhones: string[], maps: Awaited<ReturnType<typeof phoneMaps>>): Set<string> {
  const ids = new Set<string>()
  for (const raw of personPhones) {
    const e164 = parseLoosePhone(raw)
    if (!e164) continue
    const exact = maps.byExact.get(e164)
    if (exact) ids.add(exact)
    const key = phoneMatchKey(e164)
    if (key) {
      const byKey = maps.byKey.get(key)
      if (byKey) ids.add(byKey)
    }
  }
  return ids
}

export async function runBirthdayImport(
  userId: string,
  taskRunId: string | null,
  deps: BirthdayImportDeps,
): Promise<BirthdayImportResult> {
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

    // access token solo en memoria: cada corrida refresca el suyo
    const refreshToken = decryptSecret(deps.google.encryptionKey, account.refreshTokenEnc)
    const { accessToken } = await refreshAccessToken(deps.google, refreshToken, { fetch: deps.fetch })

    const connections = await fetchConnections(accessToken, {
      syncToken: account.peopleSyncToken,
      fetch: deps.fetch,
    })

    const maps = await phoneMaps(db, userId)

    let matched = 0
    let updated = 0
    let keptManual = 0
    for (const [index, person] of connections.people.entries()) {
      if (person.birthdays.length === 0) continue
      const contactIds = matchContacts(person.phones, maps)
      if (contactIds.size === 0) continue
      matched += contactIds.size

      // si Google trae varias fechas (propias y de familiares), la primera con
      // date es la del contacto
      const birthday = person.birthdays[0]!
      for (const contactId of contactIds) {
        const contact = (
          await db
            .select({ birthdaySource: contacts.birthdaySource })
            .from(contacts)
            .where(eq(contacts.id, contactId))
            .limit(1)
        )[0]
        if (!contact) continue
        if (contact.birthdaySource === 'manual') {
          keptManual += 1
          continue
        }
        await db
          .update(contacts)
          .set({
            birthMonth: birthday.month,
            birthDay: birthday.day,
            birthYear: birthday.year,
            googleResourceName: person.resourceName,
            birthdaySource: 'google',
          })
          .where(eq(contacts.id, contactId))
        updated += 1
      }
      if (index % 25 === 0) await touch(index + 1, connections.people.length)
    }

    await db
      .update(googleAccounts)
      .set({ peopleSyncToken: connections.nextSyncToken })
      .where(eq(googleAccounts.userId, userId))

    if (taskRunId) {
      await db
        .update(taskRuns)
        .set({
          status: 'done',
          processed: connections.people.length,
          total: connections.people.length,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(taskRuns.id, taskRunId))
    }

    return {
      people: connections.people.length,
      matched,
      updated,
      keptManual,
      fullResync: connections.fullResync,
      syncToken: connections.nextSyncToken,
    }
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
