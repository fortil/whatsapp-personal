# Imagen única para api y worker: se construye igual y el CMD elige por env
# (APP=api|worker). El compose de producción arranca el worker con la misma
# imagen y APP=worker. El panel tiene su propio Dockerfile (Next standalone).
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
# Primero solo los package.json: así el install se cachea aunque cambie código.
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
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY apps apps
COPY packages packages
# "..." = con sus dependencias de workspace. El panel no entra: no hace falta
# compilar Next para servir la API, y viceversa.
RUN pnpm --filter "@wp/api..." --filter "@wp/worker..." run build

# node_modules de producción (sin devDeps) para la imagen final.
FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN corepack enable
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
RUN pnpm install --frozen-lockfile --prod

# Runtime: se conserva el layout del monorepo porque los @wp/* se resuelven
# por los symlinks de pnpm entre paquetes (los symlinks sobreviven al COPY).
# La imagen también sirve para migrar: packages/db/dist/migrate.js vive aquí.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api ./apps/api
COPY --from=prod-deps /app/apps/worker ./apps/worker
COPY --from=prod-deps /app/packages ./packages
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/channels/dist ./packages/channels/dist
COPY --from=build /app/packages/llm/dist ./packages/llm/dist
COPY --from=build /app/packages/mailer/dist ./packages/mailer/dist
COPY --from=build /app/packages/google/dist ./packages/google/dist
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
# Las migraciones no se compilan: drizzle-kit deja .sql + meta/_journal.json
# versionados en packages/db/drizzle/, que migrate.ts busca como dist/../drizzle
# (packages/db/src/migrate.ts). Sin esta copia el runtime no tiene con qué migrar.
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
ARG APP=api
ENV APP=${APP}
# 3001 api, 3002 health del worker
EXPOSE 3001 3002
CMD node apps/${APP}/dist/index.js
