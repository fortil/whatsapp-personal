'use server'

import { apiFetch } from '@/lib/api'

/**
 * Puente de las acciones del panel hacia las rutas /channel/*. Toda acción
 * devuelve la máquina de estados completa: la pantalla se redibuja con lo que
 * la API responda, sin estado local paralelo.
 */

export interface ChannelState {
  estado?: 'connecting' | 'connected' | 'disconnected' | 'logged_out'
  qrEstado?: 'ok' | 'solo-codigo' | 'sin-qr' | 'sin-instancia' | 'no-aplica'
  qrBase64?: string | null
  code?: string | null
  error?: string
}

async function call(action: 'connect' | 'sync' | 'reset' | 'disconnect'): Promise<ChannelState> {
  const res = await apiFetch<ChannelState>('POST', `/channel/${action}`)
  if (res.status === 200) return res.body
  return { error: res.body?.error ?? 'no se pudo consultar el canal' }
}

export async function channelSyncAction(): Promise<ChannelState> {
  return call('sync')
}

export async function channelConnectAction(): Promise<ChannelState> {
  return call('connect')
}

export async function channelResetAction(): Promise<ChannelState> {
  return call('reset')
}

export async function channelDisconnectAction(): Promise<ChannelState> {
  return call('disconnect')
}
