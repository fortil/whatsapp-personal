import { describe, expect, it } from 'vitest'
import { fetchConnections, fetchProfileEmail, parsePerson } from './index.js'

/**
 * connections.list contra dobles del fetch con la forma real de People v1,
 * incluidas las dos páginas con pageToken/nextSyncToken y el 410 que obliga a
 * resync completo cuando el sync token guardado venció.
 */

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const ANA = {
  resourceName: 'people/c16598',
  etag: '%EgUBCjc0Pg==',
  names: [{ displayName: 'Ana María Restrepo', givenName: 'Ana María', familyName: 'Restrepo' }],
  phoneNumbers: [
    { value: '+57 300 111 1111', canonicalForm: '+573001111111', type: 'mobile' },
    { value: 'celular viejo' },
  ],
  birthdays: [{ date: { year: 1990, month: 5, day: 10 }, metadata: { primary: true } }],
}

const BETO = {
  resourceName: 'people/c17701',
  names: [{ displayName: 'Beto' }],
  phoneNumbers: [{ value: '300 222 2222' }],
  // Google entrega muchos cumpleaños sin año
  birthdays: [{ date: { month: 12, day: 24 } }],
}

describe('parsePerson', () => {
  it('mapea nombres, teléfonos crudos y cumpleaños (sin año incluido)', () => {
    const person = parsePerson(ANA)!
    expect(person.resourceName).toBe('people/c16598')
    expect(person.displayName).toBe('Ana María Restrepo')
    expect(person.phones).toEqual(['+57 300 111 1111', 'celular viejo'])
    expect(person.birthdays).toEqual([{ year: 1990, month: 5, day: 10 }])
  })

  it('cumpleaños sin date (solo text) se cae; sin resourceName es null', () => {
    expect(parsePerson({ resourceName: 'people/x', birthdays: [{ text: '25 de diciembre' }] })).toEqual({
      resourceName: 'people/x',
      displayName: null,
      phones: [],
      birthdays: [],
    })
    expect(parsePerson({ names: [{ displayName: 'Sin resource' }] })).toBeNull()
  })
})

describe('fetchConnections', () => {
  it('recorre las páginas con pageSize 200 y devuelve el nextSyncToken de la última', async () => {
    const urls: string[] = []
    const fake: typeof fetch = (input) => {
      const url = new URL(input.toString())
      urls.push(`${url.pathname}?${url.searchParams.toString()}`)
      if (url.searchParams.get('pageToken') === 'pagina-2') {
        return Promise.resolve(json(200, { connections: [BETO], nextSyncToken: 'sync-nuevo' }))
      }
      return Promise.resolve(json(200, { connections: [ANA], nextPageToken: 'pagina-2' }))
    }

    const result = await fetchConnections('ya29.access', { fetch: fake })
    expect(result.people.map((p) => p.resourceName)).toEqual(['people/c16598', 'people/c17701'])
    expect(result.nextSyncToken).toBe('sync-nuevo')
    expect(result.fullResync).toBe(false)

    expect(urls).toHaveLength(2)
    for (const u of urls) {
      expect(u).toContain('personFields=names%2CphoneNumbers%2Cbirthdays')
      expect(u).toContain('pageSize=200')
    }
    expect(urls[1]).toContain('pageToken=pagina-2')
    expect(urls[0]).not.toContain('syncToken')
  })

  it('410 con sync token vencido: reintenta en modo completo y lo reporta', async () => {
    const urls: string[] = []
    const fake: typeof fetch = (input) => {
      const url = new URL(input.toString())
      const qs = `?${url.searchParams.toString()}`
      urls.push(qs)
      if (url.searchParams.get('syncToken') === 'sync-vencido') {
        return Promise.resolve(json(410, { error: { code: 410, message: 'Sync token is expired' } }))
      }
      return Promise.resolve(json(200, { connections: [ANA, BETO], nextSyncToken: 'sync-fresco' }))
    }

    const result = await fetchConnections('ya29.access', { syncToken: 'sync-vencido', fetch: fake })
    expect(result.fullResync).toBe(true)
    expect(result.people).toHaveLength(2)
    expect(result.nextSyncToken).toBe('sync-fresco')
    // primero intentó incremental, luego completo sin syncToken
    expect(urls[0]).toContain('syncToken=sync-vencido')
    expect(urls[1]).not.toContain('syncToken')
    expect(urls).toHaveLength(2)
  })
})

describe('fetchProfileEmail', () => {
  it('prefiere el email marcado primary', async () => {
    const fake: typeof fetch = () =>
      Promise.resolve(
        json(200, {
          resourceName: 'people/me',
          emailAddresses: [
            { value: 'alias@googlemail.com', metadata: { primary: false } },
            { value: 'ana@gmail.com', metadata: { primary: true, verified: true } },
          ],
        }),
      )
    await expect(fetchProfileEmail('ya29.access', { fetch: fake })).resolves.toBe('ana@gmail.com')
  })

  it('sin ningún correo: error claro', async () => {
    const fake: typeof fetch = () => Promise.resolve(json(200, { resourceName: 'people/me' }))
    await expect(fetchProfileEmail('ya29.access', { fetch: fake })).rejects.toThrow(/ningún correo/)
  })
})
