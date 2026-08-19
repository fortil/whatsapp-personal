import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Passwords con scrypt: `salt:hash` en hex, salt de 16 bytes, keylen 64.
 * scryptSync (bloqueante) es deliberado: con cost default (~50ms) amortigua
 * cualquier intento de fuerza bruta paralela y el login es de baja concurrencia.
 */

const KEYLEN = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, salt, expected.length)
  return timingSafeEqual(actual, expected)
}

/** Hash fijo contra el que se verifica cuando el usuario NO existe. */
const DUMMY_HASH = hashPassword('contraseña-ficticia-anti-enumeración')

/**
 * Anti-enumeración de login: usuario inexistente y contraseña errónea tardan
 * lo mismo. El caller no puede distinguir "no existe" de "clave mala", así que
 * tampoco puede el atacante midiendo el tiempo de la respuesta.
 */
export function verifyPasswordOrDummy(password: string, stored: string | null): boolean {
  return verifyPassword(password, stored ?? DUMMY_HASH)
}
