# FindBack — single-container image (web shell + REST/GraphQL API)

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/api/package.json services/api/package.json
COPY apps/mobile/package.json apps/mobile/package.json
# --ignore-scripts: the root "prepare" builds packages/shared, whose sources are
# copied below; install deps first, then build explicitly.
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY services/api services/api
COPY apps/mobile apps/mobile
# apps/mobile/vite.config.ts runs scripts/check-mobile-build-config.mjs
# (which imports scripts/check-sentry-config.mjs) as a fail-closed preflight
# on every `vite build`. Without these the build stage dies with
# "Cannot find module /app/scripts/check-mobile-build-config.mjs".
COPY scripts scripts
# Fail-closed preflight still requires a real Supabase URL + publishable key.
# CI must pass them as --build-arg; unset/placeholder values keep failing the
# build on purpose. No defaults are baked in here.
ARG VITE_SUPABASE_URL=""
ARG VITE_SUPABASE_PUBLISHABLE_KEY=""
ARG VITE_PUBLIC_SHARE_ORIGIN=""
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_PUBLISHABLE_KEY=${VITE_SUPABASE_PUBLISHABLE_KEY}
ENV VITE_PUBLIC_SHARE_ORIGIN=${VITE_PUBLIC_SHARE_ORIGIN}
COPY docs/specs/model-library/catalogue.v1.json docs/specs/model-library/catalogue.v1.json
RUN npm run build -w @findback/shared \
 && npm run build -w @findback/api \
 && npm run build -w @findback/mobile

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
ENV DB_FILE=/app/data/findback.db
ENV UPLOADS_DIR=/app/uploads
ENV STATIC_WEB_DIR=/app/apps/mobile/dist
ENV PUBLIC_URL=http://localhost:4000

# Recreate dependency tree with only production deps.
# --ignore-scripts: root "prepare" builds packages/shared, which needs dev
# typescript; we instead copy the prebuilt shared dist from the build stage.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/api/package.json services/api/package.json
COPY apps/mobile/package.json apps/mobile/package.json
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/services/api/dist services/api/dist
COPY --from=build /app/apps/mobile/dist apps/mobile/dist

RUN mkdir -p /app/data /app/uploads

EXPOSE 4000
VOLUME ["/app/data", "/app/uploads"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "services/api/dist/index.js"]
