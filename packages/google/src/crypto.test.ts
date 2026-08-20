import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret } from './crypto.js'

/**
 * El contrato del cifrado del refresh token: ida y vuelta, opacidad (el texto
 * cifrado no delata el token) y detección de manipulación o key equivocada.
 * Estos tests corren de verdad, sin dobles.
 */

const KEY = '1f'.repeat(32)
const OTHER_KEY = '2e'.repeat(32)

describe('encryptSecret / decryptSecret', () => {
  it('ida y vuelta devuelve el token exacto', () => {
    const token = '1//0g refreshed-secret-token-de-google'
    expect(decryptSecret(KEY, encryptSecret(KEY, token))).toBe(token)
  })

  it('el ciphertext no contiene el token en claro y viene iv.tag.ciphertext', () => {
    const token = '1//0g refreshed-secret-token-de-google'
    const enc = encryptSecret(KEY, token)
    const parts = enc.split('.')
    expect(parts).toHaveLength(3)
    for (const part of parts) expect(part).toMatch(/^[\w-]+$/) // base64url
    expect(enc).not.toContain(token)
    expect(enc).not.toContain('refreshed-secret')
  })

  it('dos cifrados del mismo token difieren (iv aleatorio)', () => {
    const token = 'mismo-token'
    expect(encryptSecret(KEY, token)).not.toBe(encryptSecret(KEY, token))
  })

  it('ciphertext alterado: el tag de GCM no verifica y lanza', () => {
    const enc = encryptSecret(KEY, 'token-sensible')
    const [iv, tag, ciphertext] = enc.split('.')
    const tail = ciphertext!.endsWith('AA') ? 'BB' : 'AA'
    const flipped = `${ciphertext!.slice(0, -2)}${tail}`
    expect(() => decryptSecret(KEY, [iv, tag, flipped].join('.'))).toThrow()
  })

  it('key distinta no descifra', () => {
    const enc = encryptSecret(KEY, 'token-sensible')
    expect(() => decryptSecret(OTHER_KEY, enc)).toThrow()
  })

  it('key que no son 32 bytes hex rechaza antes de cifrar', () => {
    expect(() => encryptSecret('corto', 'x')).toThrow(/ENCRYPTION_KEY/)
    expect(() => encryptSecret('zz'.repeat(32), 'x')).toThrow(/ENCRYPTION_KEY/) // no hex
  })

  it('formato inesperado en reposo rechaza al descifrar', () => {
    expect(() => decryptSecret(KEY, 'no-es-un-cifrado')).toThrow(/formato inesperado/)
  })
})
