import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'WhatsApp Personal',
  description: 'Tu WhatsApp, con tus chats, contactos y recordatorios.',
}

/**
 * Fuentes por <link> y no con next/font: el build no depende de la red y el
 * HTML queda idéntico al de producción desde dev.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..700&family=Instrument+Sans:wght@400..700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  )
}
