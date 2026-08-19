/**
 * Error común a todo el paquete: lleva el status HTTP de Google para que el
 * caller distinga un 401 de token vencido de un 410 de sync token expirado
 * sin andar parseando mensajes.
 */
export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GoogleError'
  }
}

/** 410 de connections.list: el sync token guardado ya no sirve, toca resync completo. */
export class SyncTokenExpiredError extends GoogleError {
  constructor() {
    super('sync token de People API expirado (410): se necesita resync completo', 410)
    this.name = 'SyncTokenExpiredError'
  }
}
