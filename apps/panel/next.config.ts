import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // bundle autocontenido para Docker: .next/standalone con server.js propio
  output: 'standalone',
  // el ESLint del panel no se instala en esta fase; el typecheck es el gate
  eslint: { ignoreDuringBuilds: true },
}

export default nextConfig
