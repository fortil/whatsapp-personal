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
