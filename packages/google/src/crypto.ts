import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Cifrado de los refresh tokens en reposo: AES-256-GCM con ENCRYPTION_KEY
 * (variable propia de 32 bytes hex, NUNCA derivada del JWT_SECRET). Formato
 * iv.tag.ciphertext en base64url. Los access tokens no pasan por aquí: viven
 * en memoria del job y se refrescan en cada corrida.
 */

const IV_BYTES = 12

/** 32 bytes exactos en hex (64 caracteres): lo que produce openssl rand -hex 32. */
function parseKey(hexKey: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error('ENCRYPTION_KEY inválida: se esperaban 32 bytes en hex (openssl rand -hex 32)')
  }
  return Buffer.from(hexKey, 'hex')
}

export function encryptSecret(hexKey: string, plaintext: string): string {
  const key = parseKey(hexKey)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.')
}

/** Lanza si el formato no es el propio o el tag no verifica (key distinta, texto alterado). */
export function decryptSecret(hexKey: string, encrypted: string): string {
  const key = parseKey(hexKey)
  const parts = encrypted.split('.')
  if (parts.length !== 3) {
    throw new Error('refresh_token_enc con formato inesperado (se esperaba iv.tag.ciphertext)')
  }
  const [ivPart, tagPart, ctPart] = parts
  if (!ivPart || !tagPart || !ctPart) {
    throw new Error('refresh_token_enc con formato inesperado (se esperaba iv.tag.ciphertext)')
  }
  const iv = Buffer.from(ivPart, 'base64url')
  const tag = Buffer.from(tagPart, 'base64url')
  const ciphertext = Buffer.from(ctPart, 'base64url')
  if (iv.length !== IV_BYTES) {
    throw new Error('refresh_token_enc con iv de longitud inesperada')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
