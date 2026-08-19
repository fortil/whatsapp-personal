import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import {
  closeClient,
  contacts,
  getDb,
  googleAccounts,
  taskRuns,
  users,
  type Db,
} from '@wp/db'
import { encryptSecret } from '@wp/google'
import { runBirthdayImport } from './birthday-import.js'

/**
 * birthday_import contra el postgres real, con dobles del fetch para Google.
 * El zoológico de teléfonos de Google Contacts, los cumpleaños sin año, el
 * "manual nunca se pisa", el 410 de sync token y la persistencia del sync
 * token nuevo: todo aquí.
 */

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`
const ENC_KEY = '6c'.repeat(32)
const REFRESH = '1//0g.worker-refresh-token'
const GOOGLE = { clientId: 'cid', clientSecret: 'csec', encryptionKey: ENC_KEY }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
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

/** Doble del fetch: token endpoint + connections.list según el sync token que llegue. */
function googleFetch(opts: { people?: unknown[]; staleSyncToken?: string } = {}) {
  const requests: string[] = []
  const fake: typeof fetch = async (input: any, init?: any) => {
    const url = new URL(input.toString())
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}?${url.searchParams.toString()}`)
    if (url.hostname === 'oauth2.googleapis.com') {
      return json(200, { access_token: 'ya29.worker', expires_in: 3600 })
    }
    if (url.pathname.endsWith('/connections')) {
      const syncToken = url.searchParams.get('syncToken')
      if (syncToken === opts.staleSyncToken) {
        return json(410, { error: { code: 410, message: 'Sync token is expired' } })
      }
      return json(200, { connections: opts.people ?? [], nextSyncToken: 'sync-fresco' })
    }
    return json(500, { error: 'endpoint no esperado' })
  }
  return { requests, fake }
}

beforeAll(async () => {
  db = getDb()
  const [user] = await db
    .insert(users)
    .values({
      email: `worker-bday-import.${RUN}@mail.test`,
      phone: `+57306${RUN.slice(-6).padStart(6, '0')}`,
      passwordHash: 'x:y',
      status: 'approved',
    })
    .returning()
  userId = user!.id
  suiteUserIds.push(userId)

  await db.insert(googleAccounts).values({
    userId,
    googleEmail: 'ana@gmail.com',
    refreshTokenEnc: encryptSecret(ENC_KEY, REFRESH),
    scopes: 'calendar.events contacts.readonly',
  })
})

afterAll(async () => {
  await db.delete(googleAccounts).where(inArray(googleAccounts.userId, suiteUserIds)).catch(() => {})
  await db.delete(taskRuns).where(inArray(taskRuns.userId, suiteUserIds)).catch(() => {})
  await db.delete(contacts).where(inArray(contacts.userId, suiteUserIds)).catch(() => {})
  await db.delete(users).where(inArray(users.id, suiteUserIds)).catch(() => {})
  await closeClient()
})

async function contactByJid(waJid: string) {
  return (await db.select().from(contacts).where(eq(contacts.waJid, waJid)).limit(1))[0]!
}

describe('runBirthdayImport', () => {
  it('matchea teléfonos sucios, escribe con source google y no pisa lo manual', async () => {
    const ana = await insertContact({
      waJid: '573005550001@s.whatsapp.net',
      phoneE164: '+573005550001',
      displayName: 'Ana',
    })
    await insertContact({
      waJid: '573005550002@s.whatsapp.net',
      phoneE164: '+573005550002',
      displayName: 'Beto',
    })
    await insertContact({
      waJid: '573005550003@s.whatsapp.net',
      phoneE164: '+573005550003',
      displayName: 'Carla',
      birthMonth: 7,
      birthDay: 1,
      birthYear: 1980,
      birthdaySource: 'manual',
    })
    await insertContact({
      waJid: '14155550100@s.whatsapp.net',
      phoneE164: '+14155550100',
      displayName: 'Diana',
    })
    await insertContact({ waJid: '573005550005@s.whatsapp.net', phoneE164: '+573005550005', displayName: 'Sin Fecha' })
    // LID fusionado: mismo teléfono que el canónico, no debe recibir nada
    await insertContact({
      waJid: '573005550006@lid',
      phoneE164: '+573005550001',
      isLid: true,
      mergedIntoContactId: ana.id,
      displayName: 'Ana por LID',
    })

    const people = [
      {
        resourceName: 'people/cA',
        names: [{ displayName: 'Ana María' }],
        phoneNumbers: [{ value: '+57 300 555 0001' }],
        birthdays: [{ date: { year: 1990, month: 5, day: 10 } }],
      },
      {
        resourceName: 'people/cB',
        names: [{ displayName: 'Beto' }],
        phoneNumbers: [{ value: '300 555 0002' }, { value: 'no-es-un-numero' }],
        birthdays: [{ date: { month: 12, day: 24 } }], // sin año
      },
      {
        resourceName: 'people/cC',
        names: [{ displayName: 'Carla de Google' }],
        phoneNumbers: [{ value: '(300) 555-0003' }],
        birthdays: [{ date: { year: 1991, month: 1, day: 1 } }],
      },
      {
        resourceName: 'people/cD',
        names: [{ displayName: 'Diana' }],
        phoneNumbers: [{ value: '+1 (415) 555-0100' }],
        birthdays: [{ date: { year: 1985, month: 3, day: 3 } }],
      },
      {
        resourceName: 'people/cE',
        names: [{ displayName: 'Sin Fecha' }],
        phoneNumbers: [{ value: '+57 300 555 0005' }],
      },
    ]

    const [taskRun] = await db
      .insert(taskRuns)
      .values({ userId, kind: 'birthday_import', params: {} })
      .returning()

    const { fake, requests } = googleFetch({ people })
    const result = await runBirthdayImport(userId, taskRun!.id, { db, google: GOOGLE, fetch: fake })

    // el refresh del access token viajó al endpoint de token
    expect(requests.some((r) => r.startsWith('POST /token'))).toBe(true)

    const a = await contactByJid('573005550001@s.whatsapp.net')
    expect(a.birthMonth).toBe(5)
    expect(a.birthDay).toBe(10)
    expect(a.birthYear).toBe(1990)
    expect(a.birthdaySource).toBe('google')
    expect(a.googleResourceName).toBe('people/cA')

    const b = await contactByJid('573005550002@s.whatsapp.net')
    expect(b.birthMonth).toBe(12)
    expect(b.birthDay).toBe(24)
    expect(b.birthYear).toBeNull() // Google no trajo año
    expect(b.birthdaySource).toBe('google')

    const c = await contactByJid('573005550003@s.whatsapp.net')
    expect(c.birthMonth).toBe(7) // el manual queda intacto
    expect(c.birthDay).toBe(1)
    expect(c.birthYear).toBe(1980)
    expect(c.birthdaySource).toBe('manual')

    const d = await contactByJid('14155550100@s.whatsapp.net')
    expect(d.birthYear).toBe(1985)
    expect(d.birthdaySource).toBe('google')

    const e = await contactByJid('573005550005@s.whatsapp.net')
    expect(e.birthMonth).toBeNull()
    expect(e.birthdaySource).toBeNull()

    const lid = await contactByJid('573005550006@lid')
    expect(lid.birthMonth).toBeNull()

    expect(result).toMatchObject({ people: 5, updated: 3, keptManual: 1, fullResync: false })
    expect(result.syncToken).toBe('sync-fresco')

    const account = (await db.select().from(googleAccounts).where(eq(googleAccounts.userId, userId)))[0]!
    expect(account.peopleSyncToken).toBe('sync-fresco')

    const run = (await db.select().from(taskRuns).where(eq(taskRuns.id, taskRun!.id)))[0]!
    expect(run.status).toBe('done')
    expect(run.total).toBe(5)
  })

  it('410 de sync token vencido fuerza resync completo y el resultado es el mismo', async () => {
    await db
      .update(googleAccounts)
      .set({ peopleSyncToken: 'sync-vencido' })
      .where(eq(googleAccounts.userId, userId))

    const { fake, requests } = googleFetch({
      people: [
        {
          resourceName: 'people/cF',
          names: [{ displayName: 'Fernanda' }],
          phoneNumbers: [{ value: '+57 300 555 0001' }],
          birthdays: [{ date: { year: 2000, month: 9, day: 9 } }],
        },
      ],
      staleSyncToken: 'sync-vencido',
    })

    const result = await runBirthdayImport(userId, null, { db, google: GOOGLE, fetch: fake })
    expect(result.fullResync).toBe(true)
    expect(result.updated).toBe(1)

    const syncRequests = requests.filter((r) => r.includes('/connections'))
    expect(syncRequests[0]).toContain('syncToken=sync-vencido')
    expect(syncRequests[1]).not.toContain('syncToken=')
  })

  it('sin cuenta vinculada falla con mensaje claro', async () => {
    const [otro] = await db
      .insert(users)
      .values({
        email: `worker-bday-sin.${RUN}@mail.test`,
        phone: `+57307${RUN.slice(-6).padStart(6, '0')}`,
        passwordHash: 'x:y',
        status: 'approved',
      })
      .returning()
    suiteUserIds.push(otro!.id)
    await expect(runBirthdayImport(otro!.id, null, { db, google: GOOGLE })).rejects.toThrow(
      /no tiene cuenta de Google vinculada/,
    )
  })

  it('sin configuración de Google en el worker falla con mensaje claro', async () => {
    await expect(runBirthdayImport(userId, null, { db, google: null })).rejects.toThrow(
      /falta la configuración de Google/,
    )
  })
})
