# Deferred decisions — FindBack

Maintained by the implementation agent. Never let a deferred choice block the build:
use an interface/abstraction + working local/demo adapter now, isolate production
provider wiring, and document the exact files to change later.

| Decision | Temporary choice | Options later | Files to change later | Must not block now |
|---|---|---|---|---|
| Backend/cloud platform | Local Node/TS API; DB provider selectable (`DB_PROVIDER=sqlite` default, `postgres` adapter + `supabase/migrations/` in place) | Supabase / Firebase / hybrid | Set `DB_PROVIDER=postgres` + `DATABASE_URL`, run `npm run db:migrate` (`services/api/src/db/*`, `docs/DATABASE_MIGRATION.md`) | Yes |
| Auth provider | Local JWT demo adapter | Supabase Auth / Firebase Auth | `services/api/src/auth`, mobile `src/services/auth.ts` | Yes |
| Email verification | Dev adapter (returns code in dev log/response, not sent) | Supabase / Firebase / email provider | `services/api/src/providers/verification` | Yes |
| Phone verification | Dev OTP adapter | Firebase Phone Auth / SMS provider | `services/api/src/providers/verification` | Yes |
| Cloud storage | Local file storage (served from API `/uploads`) | Supabase Storage / Firebase Storage / Cloudinary / S3 | `services/api/src/providers/storage` | Yes |
| Realtime provider | Socket.IO | Supabase Realtime / Firebase listeners | `services/api/src/realtime`, mobile socket client | Yes |
| Generative AI | Generic OpenAI-compatible HTTP adapter + deterministic fallback | DeepSeek / Gemini / OpenAI | `services/api/src/providers/ai`, mobile `ai-help` | Yes |
| Hosting | Local + Docker | Render/Railway/Fly | `docker-compose.yml`, CI | Yes |
| Package ID / signing | Provisional `com.findback.app` debug | Final package + keystore | `apps/mobile/android/...`, RELEASE_SIGNING.md | Yes |
| Crystal Reports designer artifact | Data source + query + setup docs (no SAP tooling here) | Real `.rpt` via SAP tooling on Windows/VS | `docs/reporting/` | Yes — only external artifact |
| LLM provider/model | OpenAI-compatible env vars | any | `services/api/.env.example` | Yes |
| Google Maps key | Embedded fallback + iframe-capable key placeholder; dev key optional | Production key | mobile map feature | Yes |
