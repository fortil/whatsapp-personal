/**
 * Estado del botón "Transcribir" y su combinación con lo que llega del
 * servidor. Vive separado de `actions.ts` (que es 'use server' y solo puede
 * exportar funciones async) y de `TranscribeButton.tsx` para poder probarlo
 * con un test plano, sin renderizar React.
 */

export interface TranscribeState {
  status?: string
  transcript?: string | null
  error?: string
}

/**
 * `useActionState` guarda el último resultado de la action en el fiber del
 * componente, y ese fiber sigue vivo entre refrescos (revalidatePath del
 * chat, poll de AutoRefresh): el estado local no se resetea solo.
 *
 * Por eso el servidor manda en cuanto avanza más allá de 'none': si
 * `serverStatus` ya es 'pending', 'done' o 'error', esa es la verdad, sin
 * importar qué haya devuelto el último submit. El estado local solo se usa
 * como optimismo transitorio mientras el servidor sigue en 'none' (el primer
 * render, antes de que cualquier click haya llegado a la DB).
 */
export function mergeTranscribeState(
  serverStatus: string,
  serverTranscript: string | null,
  local: TranscribeState,
): { status: string; transcript: string | null } {
  if (serverStatus !== 'none') {
    return { status: serverStatus, transcript: serverTranscript }
  }
  if (local.status !== undefined) {
    return { status: local.status, transcript: local.transcript ?? null }
  }
  return { status: serverStatus, transcript: serverTranscript }
}
