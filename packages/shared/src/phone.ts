// /max trae la metadata con tipos de número: el import default no los incluye
// y getType() devuelve undefined, con lo que ningún móvil validaría.
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max'

/**
 * Celular colombiano estricto: móvil de 10 dígitos que empieza por 3.
 * Devuelve E.164 (+57...) o null. Es la validación de signup.
 */
export function normalizeCoMobile(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const parsed = parsePhoneNumberFromString(trimmed, 'CO')
  if (!parsed || !parsed.isValid()) return null
  if (parsed.country !== 'CO') return null
  if (parsed.getType() !== 'MOBILE') return null

  const nsn = parsed.nationalNumber
  if (nsn.length !== 10 || !nsn.startsWith('3')) return null

  return parsed.number
}

/**
 * Parser tolerante para los formatos sucios de Google Contacts:
 * espacios, guiones, prefijos duplicados y texto suelto alrededor.
 * Región default CO. Si libphonenumber no logra parsear, cae al fallback
 * de match por los últimos 10 dígitos: si son un móvil CO, es eso.
 * Devuelve E.164 o null.
 */
export function parseLoosePhone(input: string, defaultCountry: CountryCode = 'CO'): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry)
  if (parsed?.isValid()) return parsed.number

  const digits = trimmed.replace(/\D/g, '')
  const last10 = digits.slice(-10)
  if (/^3\d{9}$/.test(last10)) return `+57${last10}`

  return null
}

/**
 * Clave de match para comparar un teléfono de Google contra `phone_e164`
 * de un contacto: los últimos 10 dígitos. Absorbe prefijos raros
 * (57 duplicado, +00, etc.). Null si no alcanzan los dígitos.
 */
export function phoneMatchKey(e164: string): string | null {
  const digits = e164.replace(/\D/g, '')
  if (digits.length < 10) return null
  return digits.slice(-10)
}
