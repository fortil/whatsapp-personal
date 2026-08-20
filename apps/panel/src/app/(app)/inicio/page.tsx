export default function InicioPage() {
  return (
    <>
      <h1>Inicio</h1>
      <div className="card">
        <h2>La vinculación de WhatsApp llega en la fase 2</h2>
        <p className="muted">
          Esta fase dejó lista la cuenta: registro con verificación en dos pasos, sesión con dispositivos
          de confianza y el panel de administración. Cuando conectes tu WhatsApp, aquí verás tus chats.
        </p>
      </div>
      <div className="card">
        <h3>Mientras tanto</h3>
        <dl className="kv">
          <dt>Chats</dt>
          <dd className="muted">Fase 2, con la vinculación por QR</dd>
          <dt>Notas de voz</dt>
          <dd className="muted">Fase 3, transcripción local</dd>
          <dt>Exportar contactos</dt>
          <dd className="muted">Fase 4</dd>
        </dl>
      </div>
    </>
  )
}
