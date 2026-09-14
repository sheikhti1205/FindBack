# Deferred decisions — FindBack

Maintained by the implementation agent. Never let a deferred choice block the build:
use an interface/abstraction + working local/demo adapter now, isolate production
provider wiring, and document the exact files to change later.

| Decision | Temporary choice | Options later | Files to change later | Must not block now |
|---|---|---|---|---|
| Backend/cloud platform | Supabase (project provisioned); Node/TS API reaches data via the Supabase Data API (`SupabaseStore`); SQLite is the test-only backend | Supabase / Firebase / hybrid | `docs/DATABASE_MIGRATION.md`, `supabase/migrations/` | Yes |
| Auth provider | Supabase Auth when `DB_PROVIDER=supabase`; Local JWT for tests/local SQLite | Supabase Auth / Firebase Auth | `services/api/src/auth`, mobile `src/services/auth.ts` | Yes |
| Email verification | Supabase email OTP via custom SMTP in production; dev adapter for local/tests | Supabase / Firebase / email provider | `services/api/src/providers/verification`, `services/api/src/auth` | Yes |
| Phone verification | Dev OTP adapter locally; Supabase phone provider not enabled (returns "not available yet") | Firebase Phone Auth / SMS provider (Twilio, Vonage, ...) | `services/api/src/providers/verification`, `services/api/src/auth` | Yes |
| Cloud storage | Supabase Storage in production (`DB_PROVIDER=supabase`, public `findback-images` bucket, backend-only writes); local disk for tests/`DB_PROVIDER=sqlite` | Supabase Storage / Firebase Storage / Cloudinary / S3 | `services/api/src/storage`, `supabase/migrations/` | Yes |
| Realtime provider | Socket.IO | Supabase Realtime / Firebase listeners | `services/api/src/realtime`, mobile socket client | Yes |
| Generative AI | Generic OpenAI-compatible HTTP adapter + deterministic fallback | DeepSeek / Gemini / OpenAI | `services/api/src/providers/ai`, mobile `ai-help` | Yes |
| Hosting | Local + Docker | Render/Railway/Fly | `docker-compose.yml`, CI | Yes |
| Package ID / signing | Provisional `com.findback.app` debug | Final package + keystore | `apps/mobile/android/...`, RELEASE_SIGNING.md | Yes |
| Crystal Reports designer artifact | Data source + query + setup docs (no SAP tooling here) | Real `.rpt` via SAP tooling on Windows/VS | `docs/reporting/` | Yes — only external artifact |
| LLM provider/model | OpenAI-compatible env vars | any | `services/api/.env.example` | Yes |
| Google Maps key | Embedded fallback + iframe-capable key placeholder; dev key optional | Production key | mobile map feature | Yes |
