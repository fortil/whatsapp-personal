import { describe, expect, it } from 'vitest'
import { normalizeCoMobile, parseLoosePhone, phoneMatchKey } from './phone.js'

describe('normalizeCoMobile (registro, validación CO)', () => {
  it('acepta 10 dígitos sin indicativo', () => {
    expect(normalizeCoMobile('3001234567')).toBe('+573001234567')
  })

  it('acepta E.164 con espacios', () => {
    expect(normalizeCoMobile('+57 300 123 4567')).toBe('+573001234567')
  })

  it('rechaza fijos (601...)', () => {
    expect(normalizeCoMobile('6012345678')).toBeNull()
  })

  it('rechaza números de 9 dígitos', () => {
    expect(normalizeCoMobile('300123456')).toBeNull()
  })

  it('rechaza móvil de otro país aunque sea válido', () => {
    expect(normalizeCoMobile('+58 412 123 4567')).toBeNull()
  })

  it('rechaza vacío o basura', () => {
    expect(normalizeCoMobile('   ')).toBeNull()
    expect(normalizeCoMobile('hola')).toBeNull()
  })
})

describe('parseLoosePhone (Google Contacts)', () => {
  it('parsea formatos válidos directamente', () => {
    expect(parseLoosePhone('+57 300 123 4567')).toBe('+573001234567')
    expect(parseLoosePhone('300 123 4567')).toBe('+573001234567')
    expect(parseLoosePhone('300-123-4567')).toBe('+573001234567')
  })

  it('cae a los últimos 10 dígitos cuando el formato no parsea', () => {
    expect(parseLoosePhone('573001234567')).toBe('+573001234567')
    expect(parseLoosePhone('3001234567 whatsapp')).toBe('+573001234567')
    expect(parseLoosePhone('00 57 300 123 4567')).toBe('+573001234567')
  })

  it('conserva números extranjeros válidos', () => {
    expect(parseLoosePhone('+1 650 253 0000')).toBe('+16502530000')
  })

  it('conserva fijos válidos: el match contra móviles fallará solo', () => {
    expect(parseLoosePhone('6012345678')).toBe('+576012345678')
  })

  it('null si no hay nada usable', () => {
    expect(parseLoosePhone('')).toBeNull()
    expect(parseLoosePhone('casa')).toBeNull()
    expect(parseLoosePhone('12345')).toBeNull()
  })
})

describe('phoneMatchKey (match de cumpleaños)', () => {
  it('usa los últimos 10 dígitos con o sin +', () => {
    expect(phoneMatchKey('+573001234567')).toBe('3001234567')
    expect(phoneMatchKey('573001234567')).toBe('3001234567')
  })

  it('null si no alcanzan los dígitos', () => {
    expect(phoneMatchKey('12345')).toBeNull()
  })
})
