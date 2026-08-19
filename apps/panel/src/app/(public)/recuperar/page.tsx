import RecoverForm from './RecoverForm'

export default function RecuperarPage() {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">WhatsApp Personal</div>
        <h1>Recuperar acceso</h1>
        <p className="auth-hint">Te enviamos un código al correo de la cuenta para elegir una contraseña nueva.</p>
        <RecoverForm />
      </div>
    </div>
  )
}
