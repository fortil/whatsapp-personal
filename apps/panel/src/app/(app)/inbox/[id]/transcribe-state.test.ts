import { describe, expect, it } from 'vitest'
import { mergeTranscribeState, transcribeView } from './transcribe-state'

/**
 * Reproduce el hallazgo M1 de la revisión: `useActionState` deja el estado
 * local en 'pending' después del primer click, y ese estado sobrevive a los
 * refrescos porque el componente no se remonta. Si el merge vuelve a la
 * fórmula vieja (`state.status ?? status`, donde el local siempre gana una
 * vez definido), estos casos fallan.
 */
describe('mergeTranscribeState', () => {
  it('sin click todavía: usa el estado del servidor', () => {
    expect(mergeTranscribeState('none', null, {})).toEqual({ status: 'none', transcript: null })
  })

  it('justo después del click: el optimismo local se ve mientras el servidor sigue en none', () => {
    expect(mergeTranscribeState('none', null, { status: 'pending', transcript: null })).toEqual({
      status: 'pending',
      transcript: null,
    })
  })

  it('el job terminó bien: el servidor manda aunque el local quedó en pending', () => {
    // Este es el caso exacto del hallazgo: la action devolvió {status:'pending'}
    // y el AutoRefresh de 5s trae transcript_status='done' de la DB.
    const local = { status: 'pending', transcript: null }
    expect(mergeTranscribeState('done', 'hola, este es el audio', local)).toEqual({
      status: 'done',
      transcript: 'hola, este es el audio',
    })
  })

  it('el job falló agotando intentos: el servidor manda y habilita "Reintentar"', () => {
    const local = { status: 'pending', transcript: null }
    expect(mergeTranscribeState('error', null, local)).toEqual({ status: 'error', transcript: null })
  })

  it('un click posterior por otro tab: el servidor sigue mandando sobre el local viejo', () => {
    // el local quedó en 'done' de un click anterior; la DB ya reporta 'error'
    // (p.ej. reintento fallido desde otra pestaña)
    const local = { status: 'done', transcript: 'texto viejo' }
    expect(mergeTranscribeState('error', null, local)).toEqual({ status: 'error', transcript: null })
  })
})

describe('transcribeView', () => {
  // el componente calcula view sobre el estado ya combinado: misma composición aquí
  const view = (status: string, transcript: string | null) => {
    const merged = mergeTranscribeState(status, transcript, {})
    return transcribeView(merged.status, merged.transcript)
  }

  it('done con transcripción: la transcripción inline', () => {
    expect(view('done', 'hola, este es el audio')).toBe('transcript')
  })

  it('done con transcripción vacía: aviso de sin voz, no el botón de vuelta', () => {
    // el caso de un audio sin habla: el worker guarda el text.trim() del ASR
    // (cadena vacía) con transcript_status='done'. Volver al botón parece que
    // el click no hizo nada.
    expect(view('done', '')).toBe('no-voice')
    expect(view('done', null)).toBe('no-voice')
  })

  it('pending: el chip transcribiendo', () => {
    expect(view('pending', null)).toBe('pending')
  })

  it('none y error: el botón (error lo pinta como reintentar)', () => {
    expect(view('none', null)).toBe('button')
    expect(view('error', null)).toBe('button')
  })
})
