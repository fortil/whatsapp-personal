import VerifyForm from './VerifyForm'

export default async function VerificarPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>
}) {
  const params = await searchParams
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">WhatsApp Personal</div>
        <h1>Verificar tu cuenta</h1>
        <p className="auth-hint">Primero el correo; el SMS solo sale cuando el correo está verificado.</p>
        <VerifyForm initialEmail={params.email ?? ''} />
      </div>
    </div>
  )
}
