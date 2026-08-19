/**
 * Payloads sintéticos con la forma real de Baileys/Evolution v2 para los
 * tests de ingest y del webhook. No hay instancia real en este run: la
 * verificación con WhatsApp vivo la hace el humano después. Los jid y
 * timestamps son fijos porque cada run crea su propio usuario y las filas
 * cuelgan de él.
 */

/** Envelope que entrega Evolution en el webhook. */
export function upsertEvent(instance: string, data: unknown): Record<string, unknown> {
  return { event: 'messages.upsert', instance, data, date_time: '2026-08-19T12:00:00Z' }
}

export function connectionEvent(instance: string, state: string): Record<string, unknown> {
  return { event: 'connection.update', instance, data: { state }, date_time: '2026-08-19T12:00:00Z' }
}

export const textIn = {
  key: { remoteJid: '573001112233@s.whatsapp.net', fromMe: false, id: 'FIX-TEXT-1' },
  pushName: 'María',
  message: { conversation: 'hola, ¿me pasas la dirección?' },
  messageTimestamp: 1787000000,
  messageType: 'conversation',
  source: 'android',
}

export const audioIn = {
  key: { remoteJid: '573001112233@s.whatsapp.net', fromMe: false, id: 'FIX-AUDIO-1' },
  pushName: 'María',
  message: {
    audioMessage: {
      url: 'https://mmg.whatsapp.net/v/t62.7118-24/abc.ogg',
      mimetype: 'audio/ogg; codecs=opus',
      seconds: 9,
      fileLength: 12345,
    },
  },
  messageTimestamp: 1787000060,
  messageType: 'audioMessage',
  source: 'android',
}

export const fromMeText = {
  key: { remoteJid: '573001112233@s.whatsapp.net', fromMe: true, id: 'FIX-OUT-1' },
  pushName: '',
  message: { extendedTextMessage: { text: 'claro, te la envío en un rato' } },
  messageTimestamp: 1787000100,
  messageType: 'extendedTextMessage',
  source: 'web',
}

export const groupText = {
  key: { remoteJid: '12036302@g.us', fromMe: false, id: 'FIX-GROUP-1' },
  pushName: 'Pedro',
  message: { conversation: 'nos vemos a las 8' },
  messageTimestamp: 1787000120,
  messageType: 'conversation',
  source: 'android',
}

export const editedText = {
  key: { remoteJid: '573001112233@s.whatsapp.net', fromMe: false, id: 'FIX-EDIT-1' },
  pushName: 'María',
  message: {
    editedMessage: {
      conversation: 'hola, ¿me pasas la dirección nueva?',
      messageTimestamp: 1787000001,
    },
  },
  messageTimestamp: 1787000140,
  messageType: 'editedMessage',
  source: 'android',
}

export const reaction = {
  key: { remoteJid: '573001112233@s.whatsapp.net', fromMe: false, id: 'FIX-REACT-1' },
  pushName: 'María',
  message: { reactionMessage: { key: { id: 'FIX-TEXT-1' }, text: 'ok' } },
  messageTimestamp: 1787000160,
  messageType: 'reactionMessage',
  source: 'android',
}

/**
 * LID con el teléfono real: el mismo contacto que ya existe como
 * 573004445566@s.whatsapp.net llega ahora como @lid y el payload trae
 * senderPn (Baileys lo pone junto al key en los episodios LID-first).
 */
export const lidWithPn = {
  key: {
    remoteJid: '987654321012345@lid',
    fromMe: false,
    id: 'FIX-LID-PN-1',
    senderPn: '573004445566@s.whatsapp.net',
  },
  pushName: 'Carlos',
  message: { conversation: 'listo, entonces quedamos así' },
  messageTimestamp: 1787000200,
  messageType: 'conversation',
  source: 'android',
}

/** LID sin rastro del teléfono: contacto standalone, fusionable después. */
export const lidNoPhone = {
  key: { remoteJid: '555444333222111@lid', fromMe: false, id: 'FIX-LID-NOPHONE-1' },
  pushName: 'Ana',
  message: { conversation: 'buenas tardes' },
  messageTimestamp: 1787000240,
  messageType: 'conversation',
  source: 'android',
}
