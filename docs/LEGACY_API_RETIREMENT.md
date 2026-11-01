# Legacy Node API retirement

The Product Fit Reset removes `services/api`, its workspace/commands/dependencies,
Dockerfile/compose reference runtime, CI health job, release reference-container
step and course activity-report CLI. Git is the archive; there is no second
supported backend or local JWT/SQLite demo login.

## Non-use boundary

Mobile/web production source and Edge Functions have no import/HTTP dependency on
the Node API, GraphQL or socket.io client. Supabase Auth, Data API/RPC/RLS, Storage,
Realtime and Edge Functions own production behavior. Repository deployment jobs
target Supabase, Azure's existing website and Android packaging. The removed
container was only a CI/release reference health check, not a published service.
`scripts/legacy-api-retirement.test.mjs` prevents these dependencies returning.

## Test preservation

Unique live-contract tests were moved intact to `apps/mobile/src/contracts/`:
staging-upload/calendar migrations, multi-image migration, shared-schema
compatibility and phone/YouTube validation. The bounded Zod collection regression
was retained. These run in the existing mobile Vitest gate. Tests specific to
deleted Express/GraphQL/SQLite/Sharp/server-provider behavior were retired with
that implementation. Offline dependency-floor and tamper tests remain intact.

No live SQL migration, Edge handler, recovery-oriented messaging, auth/session,
media preparation, local matching or optional BYOK AI Chat was removed. Optional
AI Chat still uses the user's provider key and model choice; no shared provider
key or local-generative platform is introduced.

Course reporting/ERD and migration-transition documents are historical references,
not setup/run instructions. Current setup: [DEVELOPMENT.md](DEVELOPMENT.md).
Current backend: [ARCHITECTURE.md](ARCHITECTURE.md). Local source verification is
not proof of hosted deployment, real accounts or device acceptance.
