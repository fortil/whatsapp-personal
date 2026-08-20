/** Etiquetas y clases de badge para estados de cuenta, compartidas por las vistas. */

export const STATUS_LABEL: Record<string, string> = {
  pending_verification: 'por verificar',
  pending_approval: 'por aprobar',
  approved: 'aprobada',
  rejected: 'rechazada',
  suspended: 'suspendida',
}

export function badgeClass(status: string): string {
  if (status === 'approved') return 'badge-approved'
  if (status === 'rejected') return 'badge-rejected'
  if (status === 'suspended') return 'badge-suspended'
  return 'badge-pending' // pending_verification y pending_approval
}

/** Etiquetas de task_runs, compartidas por /contactos y /tareas. */
export const TASK_KIND_LABEL: Record<string, string> = {
  contacts_sync: 'Sincronizar contactos',
  summarize: 'Resumen de conversación',
  contacts_export: 'Exportar a Excel',
  birthday_import: 'Importar cumpleaños',
  birthday_calendar_sync: 'Sincronizar calendario',
}

export const TASK_STATUS_LABEL: Record<string, string> = {
  queued: 'en cola',
  running: 'en curso',
  done: 'lista',
  error: 'con error',
}

export function taskStatusBadgeClass(status: string): string {
  if (status === 'done') return 'badge-approved'
  if (status === 'error') return 'badge-rejected'
  if (status === 'running') return 'badge-pending'
  return 'badge-suspended' // queued
}
