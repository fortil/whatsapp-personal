# Panel Next.js en modo standalone (output: 'standalone' en next.config.ts):
# el build genera .next/standalone con su propio server.js y node_modules
# recortados. El contexto de build SIEMPRE es la raíz del monorepo:
#   docker build -f apps/panel/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
# Todos los package.json del workspace: el lockfile congelado exige que los
# importers existan, aunque luego solo se instalen los del panel (--filter).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/panel/package.json apps/panel/
COPY packages/db/package.json packages/db/
COPY packages/channels/package.json packages/channels/
COPY packages/llm/package.json packages/llm/
COPY packages/mailer/package.json packages/mailer/
COPY packages/google/package.json packages/google/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @wp/panel
COPY tsconfig.base.json ./
COPY apps/panel apps/panel
RUN pnpm --filter @wp/panel run build

# En un monorepo el standalone replica la estructura: server.js queda en
# apps/panel/ dentro del bundle, con node_modules en la raíz del mismo.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/panel/.next/standalone ./
COPY --from=build /app/apps/panel/.next/static ./apps/panel/.next/static
EXPOSE 3000
CMD ["node", "apps/panel/server.js"]
