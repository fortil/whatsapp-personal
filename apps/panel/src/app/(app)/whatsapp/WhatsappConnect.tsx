'use client'

import { useEffect, useState } from 'react'
import {
  channelConnectAction,
  channelDisconnectAction,
  channelResetAction,
  channelSyncAction,
  type ChannelState,
} from './actions'

/**
 * Pantalla de vinculación: consulta el estado del canal cada 5 s (pausada si
 * la pestaña está oculta) y muestra QR, código de emparejamiento o el aviso
 * de riesgo según donde esté el flujo.
 */

const ESTADO_LABEL: Record<NonNullable<ChannelState['estado']>, string> = {
  connecting: 'vinculando',
  connected: 'conectado',
  disconnected: 'desconectado',
  logged_out: 'sesión cerrada',
}

const ESTADO_BADGE: Record<NonNullable<ChannelState['estado']>, string> = {
  connecting: 'badge-pending',
  connected: 'badge-approved',
  disconnected: 'badge-suspended',
  logged_out: 'badge-suspended',
}

const QR_HINT: Record<NonNullable<ChannelState['qrEstado']>, string> = {
  ok: 'Escanea el código desde WhatsApp (Configuración, dispositivos vinculados).',
  'solo-codigo': 'Ingresa este código en WhatsApp (Configuración, Vincular con número).',
  'sin-qr': 'La instancia no entregó QR. Un reset suele resolverlo.',
  'sin-instancia': 'Todavía no hay instancia creada para tu cuenta.',
  'no-aplica': '',
}

function qrSrc(base64: string): string {
  return base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`
}

export default function WhatsappConnect({ initial }: { initial: ChannelState }) {
  const [state, setState] = useState<ChannelState>(initial)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    const timer = setInterval(async () => {
      if (document.visibilityState === 'hidden' || busy) return
      try {
        setState(await channelSyncAction())
      } catch {
        // la API puede estar reiniciando; el siguiente ciclo reintenta
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [busy])

  async function run(action: () => Promise<ChannelState>) {
    setBusy(true)
    setActionError(null)
    try {
      setState(await action())
    } catch {
      setActionError('La acción falló. Revisa tu conexión e intenta de nuevo.')
    } finally {
      setBusy(false)
    }
  }

  const conectando = state.estado === 'connecting' || state.estado === 'connected'
  const sinInstancia = state.qrEstado === 'sin-instancia'

  return (
    <>
      {state.error ? <div className="form-error">{state.error}</div> : null}
      {actionError ? <div className="form-error">{actionError}</div> : null}

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginBottom: 0 }}>Estado del canal</h2>
          {state.estado ? (
            <span className={`badge ${ESTADO_BADGE[state.estado]}`}>{ESTADO_LABEL[state.estado]}</span>
          ) : null}
        </div>

        {state.qrEstado === 'ok' && state.qrBase64 ? (
          <div className="qr-wrap">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrSrc(state.qrBase64)} alt="Código QR para vincular WhatsApp" />
            <p className="muted">{QR_HINT.ok}</p>
          </div>
        ) : null}

        {state.qrEstado === 'solo-codigo' && state.code ? (
          <div className="qr-wrap">
            <div className="pairing-code">{state.code}</div>
            <p className="muted">{QR_HINT['solo-codigo']}</p>
          </div>
        ) : null}

        {['sin-qr', 'sin-instancia'].includes(state.qrEstado ?? '') ? (
          <p className="muted">{QR_HINT[state.qrEstado as 'sin-qr' | 'sin-instancia']}</p>
        ) : null}

        <div className="row">
          {!conectando ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !consent}
              onClick={() => void run(channelConnectAction)}
            >
              {busy ? 'Trabajando…' : sinInstancia ? 'Conectar WhatsApp' : 'Volver a conectar'}
            </button>
          ) : null}
          {conectando ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void run(channelDisconnectAction)}
            >
              Desconectar
            </button>
          ) : null}
          {!sinInstancia ? (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || !consent}
              onClick={() => void run(channelResetAction)}
            >
              Reset (borra la vinculación)
            </button>
          ) : null}
        </div>
      </div>

      <div className="card">
        <h3>Antes de vincular tu número</h3>
        <p>
          La vinculación usa Evolution API, un cliente no oficial de WhatsApp. Meta no lo autoriza y
          puede banear la cuenta: pierdes el número y el historial. Ese riesgo lo corrés vos, no la
          plataforma.
        </p>
        <p>Si el número es tu línea personal, considera usar un número dedicado para esto.</p>
        <label className="check">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
          />
          Entiendo el riesgo de baneo y quiero vincular este número.
        </label>
      </div>
    </>
  )
}
