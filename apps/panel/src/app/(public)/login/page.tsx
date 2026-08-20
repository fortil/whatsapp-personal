import LoginForm from './LoginForm'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string }>
}) {
  const params = await searchParams
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">WhatsApp Personal</div>
        <h1>Entrar</h1>
        <p className="auth-hint">Tu correo o celular y tu contraseña. Después, un código de un solo uso.</p>
        <LoginForm passwordChanged={params.ok === 'password-changed'} />
        <p className="auth-alt">
          ¿Sin cuenta? <a href="/registro">Registrarme</a>
        </p>
      </div>
    </div>
  )
}
