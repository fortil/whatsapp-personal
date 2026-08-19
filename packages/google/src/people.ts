import { GoogleError, SyncTokenExpiredError } from './error.js'

/**
 * People API v1 (people.connections.list) con fetch crudo. El zoológico de
 * formatos de teléfonos NO se resuelve aquí: este módulo devuelve los valores
 * tal como vienen y el parseo tolerante vive en @wp/shared (parseLoosePhone).
 */

export const PEOPLE_CONNECTIONS_URL = 'https://people.googleapis.com/v1/people/me/connections'
export const PEOPLE_ME_URL = 'https://people.googleapis.com/v1/people/me'
export const PEOPLE_PAGE_SIZE = 200

/** Lo mínimo que usamos de una conexión; birthdays sin date (solo text) se caen. */
export interface GooglePerson {
  resourceName: string
  displayName: string | null
  phones: string[]
  birthdays: Array<{ year: number | null; month: number; day: number }>
}

export interface PeopleFetchOptions {
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface FetchConnectionsResult {
  people: GooglePerson[]
  /** El nuevo sync token para la próxima corrida incremental; null si Google no lo devolvió. */
  nextSyncToken: string | null
  /** True si el sync token guardado vino vencido y se hizo resync completo. */
  fullResync: boolean
}

interface RawPage {
  connections?: unknown[]
  nextPageToken?: unknown
  nextSyncToken?: unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** Una página de connections.list; 410 se traduce a SyncTokenExpiredError. */
async function fetchPage(
  accessToken: string,
  opts: { pageToken?: string | null; syncToken?: string | null; fetch?: typeof fetch; timeoutMs?: number },
): Promise<RawPage> {
  const params = new URLSearchParams({
    personFields: 'names,phoneNumbers,birthdays',
    pageSize: String(PEOPLE_PAGE_SIZE),
  })
  if (opts.pageToken) params.set('pageToken', opts.pageToken)
  if (opts.syncToken) params.set('syncToken', opts.syncToken)

  const doFetch = opts.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(`${PEOPLE_CONNECTIONS_URL}?${params.toString()}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    })
  } catch (err) {
    throw new GoogleError(`no se pudo hablar con People API: ${err instanceof Error ? err.message : err}`)
  }
  if (res.status === 410) throw new SyncTokenExpiredError()
  if (res.status === 401 || res.status === 403) {
    const detail = await res.text().catch(() => '')
    throw new GoogleError(`token de acceso rechazado por People API → ${res.status} ${detail.slice(0, 200)}`, res.status)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new GoogleError(`connections.list → ${res.status} ${detail.slice(0, 200)}`, res.status)
  }
  try {
    return JSON.parse(await res.text()) as RawPage
  } catch {
    throw new GoogleError('connections.list → respuesta no es JSON')
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Convierte una conexión cruda a GooglePerson; null si no tiene resourceName. */
export function parsePerson(raw: unknown): GooglePerson | null {
  const record = asRecord(raw)
  const resourceName = str(record.resourceName)
  if (!resourceName) return null

  const names = Array.isArray(record.names) ? record.names : []
  const displayName = names.map((n) => str(asRecord(n).displayName)).find(Boolean) ?? null

  const phoneNumbers = Array.isArray(record.phoneNumbers) ? record.phoneNumbers : []
  const phones = phoneNumbers
    .map((p) => str(asRecord(p).value))
    .filter((p): p is string => p !== null)

  const rawBirthdays = Array.isArray(record.birthdays) ? record.birthdays : []
  const birthdays: GooglePerson['birthdays'] = []
  for (const rawBirthday of rawBirthdays) {
    const date = asRecord(asRecord(rawBirthday).date)
    const month = date.month
    const day = date.day
    if (typeof month !== 'number' || typeof day !== 'number') continue
    // Google entrega muchos cumpleaños sin año: por eso birth_year es nullable
    const year = typeof date.year === 'number' ? date.year : null
    birthdays.push({ year, month, day })
  }

  return { resourceName, displayName, phones, birthdays }
}

/**
 * Recorre todas las páginas de connections.list. Si el syncToken guardado ya
 * expiró (410), arranca de cero en modo completo y devuelve lo que encuentre:
 * el caller solo persiste el nextSyncToken nuevo.
 */
export async function fetchConnections(
  accessToken: string,
  opts: { syncToken?: string | null; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<FetchConnectionsResult> {
  let people: GooglePerson[] = []
  let nextSyncToken: string | null = null
  let fullResync = false

  let syncToken = opts.syncToken ?? null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      people = []
      nextSyncToken = null
      let pageToken: string | null = null
      do {
        const page = await fetchPage(accessToken, { ...opts, pageToken, syncToken })
        for (const raw of page.connections ?? []) {
          const person = parsePerson(raw)
          if (person) people.push(person)
        }
        pageToken = str(page.nextPageToken)
        const pageSyncToken = str(page.nextSyncToken)
        if (pageSyncToken) nextSyncToken = pageSyncToken
      } while (pageToken)
      return { people, nextSyncToken, fullResync }
    } catch (err) {
      if (err instanceof SyncTokenExpiredError && syncToken && attempt === 0) {
        // token vencido: resync completo desde la primera página
        fullResync = true
        syncToken = null
        continue
      }
      throw err
    }
  }
  // inalcanzable: el loop de arriba siempre retorna o lanza en la segunda vuelta
  throw new GoogleError('connections.list no convergió')
}

/** Correo de la cuenta conectada, para google_accounts.google_email. */
export async function fetchProfileEmail(
  accessToken: string,
  opts: PeopleFetchOptions = {},
): Promise<string> {
  const doFetch = opts.fetch ?? fetch
  const params = new URLSearchParams({ personFields: 'emailAddresses' })
  let res: Response
  try {
    res = await doFetch(`${PEOPLE_ME_URL}?${params.toString()}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
  } catch (err) {
    throw new GoogleError(`no se pudo hablar con People API: ${err instanceof Error ? err.message : err}`)
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new GoogleError(`people/me → ${res.status} ${detail.slice(0, 200)}`, res.status)
  }
  let json: unknown
  try {
    json = JSON.parse(await res.text())
  } catch {
    throw new GoogleError('people/me → respuesta no es JSON')
  }
  const emails: unknown[] = Array.isArray(asRecord(json).emailAddresses)
    ? (asRecord(json).emailAddresses as unknown[])
    : []
  // el primario primero; si nada marca primary, el primero que haya
  const primary = emails.find((e) => asRecord(asRecord(e).metadata).primary === true)
  const email = str(asRecord(primary ?? emails[0]).value)
  if (!email) throw new GoogleError('people/me no devolvió ningún correo')
  return email
}
