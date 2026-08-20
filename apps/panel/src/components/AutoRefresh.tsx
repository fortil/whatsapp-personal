'use client'

import { useEffect } from 'react'

/**
 * Polling vía Server Action: la acción revalida la ruta y Next devuelve el
 * HTML nuevo. Pausado cuando la pestaña está oculta (no gasta API ni batería).
 *
 * La acción llega como referencia de server action; para pasarle un id se usa
 * action.bind(null, id) desde el server component.
 */
export default function AutoRefresh({
  intervalMs,
  action,
}: {
  intervalMs: number
  action: () => Promise<void>
}) {
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void action()
    }, intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs, action])
  return null
}
