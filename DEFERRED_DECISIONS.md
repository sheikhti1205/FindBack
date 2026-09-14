# Deferred decisions — FindBack

Maintained by the implementation agent. Never let a deferred choice block the build:
use an interface/abstraction + working local/demo adapter now, isolate production
provider wiring, and document the exact files to change later.

| Decision | Temporary choice | Options later | Files to change later | Must not block now |
|---|---|---|---|---|
| Backend/cloud platform | Supabase (project provisioned); Node/TS API reaches data via the Supabase Data API (`SupabaseStore`); SQLite is the test-only backend | Supabase / Firebase / hybrid | `docs/DATABASE_MIGRATION.md`, `supabase/migrations/` | Yes |
| Auth provider | Supabase Auth when `DB_PROVIDER=supabase`; Local JWT for tests/local SQLite | Supabase Auth / Firebase Auth | `services/api/src/auth`, mobile `src/services/auth.ts` | Yes |
| Email verification | Supabase email OTP via custom SMTP in production; dev adapter for local/tests | Supabase / Firebase / email provider | `services/api/src/auth`, `services/api/src/domain/verificationService.ts` | Yes |
| Phone verification | Deferred — no SMS provider configured; the app shows the stored phone as unverified and calls no verification service (the Node dev OTP adapter is local-demo/reference only) | Firebase Phone Auth / SMS provider (Twilio, Vonage, ...) | `services/api/src/auth` (reference), mobile `screens/Verify.tsx` | Yes |
| Cloud storage | Supabase Storage, **uploaded directly by the app** (on-device normalization → public `findback-images` bucket under the caller's `<uid>/` folder, owner-scoped RLS); the Node `/uploads` + `sharp` path is retained for the reference API and tests; local disk for `DB_PROVIDER=sqlite` | Supabase Storage / Firebase Storage / Cloudinary / S3 | `apps/mobile/src/services/image.ts`, `supabase/migrations/`, `services/api/src/storage` (legacy) | Yes |
| Realtime provider | Supabase Realtime Broadcast (private channels, DB triggers send sanitized payloads); Node Socket.IO source retained as reference | Supabase Realtime / Firebase listeners | `services/api/src/realtime`, mobile `src/services/realtime.ts` | Yes |
| REST/GraphQL API | Supabase PostgREST (`/rest/v1`) + `pg_graphql` (`/graphql/v1`) are the runtime API; Node Express + GraphQL-Yoga retained as a Docker/coursework reference | Supabase / Node | `supabase/migrations/`, `docs/API_DEMO.md`, `services/api/src/{app.ts,graphql}` (legacy) | Yes |
| Generative AI | Help Assistant on the Supabase Edge Function `ai-help` (JWT-verified, authenticated-only) → generic OpenAI-compatible HTTP provider when `LLM_BASE_URL`/`LLM_API_KEY` secrets are set, deterministic fallback otherwise | DeepSeek / Gemini / OpenAI | `supabase/functions/ai-help`, `services/api/src/providers/ai` (legacy) | Yes |
| Hosting | Local + Docker reference image (SQLite mode) + GitHub Actions CI (lint/typecheck/tests/web build + Docker build/run/health-check); the Android app itself connects directly to hosted Supabase and needs no Docker | Render/Railway/Fly | `docker-compose.yml`, `Dockerfile`, `.github/workflows/ci.yml` | Yes |
| Package ID / signing | Provisional `com.findback.app` debug | Final package + keystore | `apps/mobile/android/...`, RELEASE_SIGNING.md | Yes |
| Crystal Reports designer artifact | Data source + query + setup docs (no SAP tooling here) | Real `.rpt` via SAP tooling on Windows/VS | `docs/reporting/` | Yes — only external artifact |
| LLM provider/model | OpenAI-compatible env vars | any | `services/api/.env.example` | Yes |
| Google Maps key | Keyless Google Maps embed (`maps?q=…&output=embed`) + one-time browser geolocation; no API key or billing needed | Production Maps API key (only if a richer map is required) | mobile map feature | Yes |
