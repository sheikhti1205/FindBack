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
#
# MONITOR-IT policy (SYNC reference lane): every Docker image built for
# reference/verification (CI `docker` job, release gate) is a MONITORED build —
# it must carry the same Sentry DSN/release/dist identity as the lane that
# built it, never a silent Sentry-blind shell. Local empty-safe builds (compose
# without Sentry vars) stay buildable but log an explicit UNMONITORED warning
# at verification time; any production/reference use without a DSN is a
# lane-level configuration failure, never a quiet default here.
ARG VITE_SUPABASE_URL=""
ARG VITE_SUPABASE_PUBLISHABLE_KEY=""
ARG VITE_PUBLIC_SHARE_ORIGIN=""
ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_ENVIRONMENT="production"
ARG VITE_SENTRY_TRACES_SAMPLE_RATE="0.1"
ARG VITE_SENTRY_RELEASE=""
ARG VITE_SENTRY_DIST="docker-reference"
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_PUBLISHABLE_KEY=${VITE_SUPABASE_PUBLISHABLE_KEY}
ENV VITE_PUBLIC_SHARE_ORIGIN=${VITE_PUBLIC_SHARE_ORIGIN}
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
ENV VITE_SENTRY_ENVIRONMENT=${VITE_SENTRY_ENVIRONMENT}
ENV VITE_SENTRY_TRACES_SAMPLE_RATE=${VITE_SENTRY_TRACES_SAMPLE_RATE}
ENV VITE_SENTRY_RELEASE=${VITE_SENTRY_RELEASE}
ENV VITE_SENTRY_DIST=${VITE_SENTRY_DIST}
COPY docs/specs/model-library/catalogue.v1.json docs/specs/model-library/catalogue.v1.json
RUN npm run build -w @findback/shared \
 && npm run build -w @findback/api \
 && npm run build -w @findback/mobile
# Baked-config verification (runs inside the build stage, on the exact bytes
# copied to runtime below): Supabase preflight always; Sentry bundle asserts
# whenever a DSN was provided. Empty DSN = local empty-safe path with an
# explicit UNMONITORED warning (never a silent pass). Shapes only in logs.
RUN node scripts/check-mobile-build-config.mjs --preflight && \
  node -e 'const r=(process.env.VITE_SENTRY_TRACES_SAMPLE_RATE||"0.1").trim(); const n=Number(r); if(!Number.isFinite(n)||n<0||n>1){console.error(`docker baked-config: bad VITE_SENTRY_TRACES_SAMPLE_RATE ${r} (want number in 0..1)`);process.exit(1)} console.log(`docker baked-config: traces sample rate OK (${n})`)' && \
  if [ -n "$VITE_SENTRY_DSN" ]; then \
    node scripts/check-mobile-build-config.mjs --assets apps/mobile/dist/assets && \
    if [ -n "$VITE_SENTRY_RELEASE" ]; then JS=$(ls apps/mobile/dist/assets/index-*.js | head -1); grep -q "$VITE_SENTRY_RELEASE" "$JS" || { echo "docker baked-config: Sentry release identity missing from built bundle"; exit 1; }; echo "docker baked-config: Sentry release $VITE_SENTRY_RELEASE dist $VITE_SENTRY_DIST env $VITE_SENTRY_ENVIRONMENT verified"; else echo "docker baked-config: WARNING — no VITE_SENTRY_RELEASE baked (maps cannot be matched to this image)"; fi; \
  else echo "findback(docker): WARNING — VITE_SENTRY_DSN empty, image is UNMONITORED (local development only)"; fi

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
