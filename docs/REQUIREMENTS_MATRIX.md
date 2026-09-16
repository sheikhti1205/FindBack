# Requirements matrix — FindBack

Traceability for the 24 teacher requirements of the Mobile App Development Lab.

Status vocabulary (from the project brief):
`DONE` · `DONE_DEMO_PROVIDER` · `DEFERRED_EXTERNAL_PROVIDER` ·
`DEFERRED_EXTERNAL_TOOL` · `NOT_DONE` · `TODO`

Last updated: 2026-09-14 (Block 10K documentation pass: the mobile runtime is now **Supabase-only** — no Node API base URL, no `apiFetch`/`apiBase`, no `socket.io-client`, no cleartext/mixed-content Android allowances, and no localhost/LAN/port-4000 escape hatch. Auth/session, feed, post create/status, comments, reactions, ratings, Realtime, Storage uploads and AI Help were exercised in the browser with the Node server stopped and only `*.supabase.co` traffic observed.)
Statuses are only non-TODO when verifiable end-to-end (API tests green + live
mobile/UI flow exercised).

| # | Teacher requirement | FindBack implementation | Code path | Demo steps | Tests | Status |
|---|---|---|---|---|---|---|
| 1 | ERD as scalable PDF | Vector PDF (reportlab) + Mermaid source | `docs/erd/ERD.pdf`, `docs/erd/ERD.md`, `tools/render_erd.py` | open PDF, zoom (vector) | — | DONE |
| 2 | Real-time comments (own DB) | Supabase Realtime Broadcast (private `post:<id>` channel) + direct comment RPCs | `supabase/migrations/20260914210000_realtime_broadcast.sql`; mobile `services/realtime.ts`, `screens/PostDetail.tsx` | two sessions, comment appears live | `realtime.test.ts`, `social.test.ts` | DONE |
| 3 | Like/dislike live count | reactions upsert + Supabase Realtime broadcast (aggregate counts, no user ids) | `supabase/migrations/20260914210000_realtime_broadcast.sql`, `20260914200000_social_client_rpcs.sql` | two sessions | `social.test.ts`, `realtime.test.ts` | DONE |
| 4 | Live unique username check | debounced direct Supabase username lookup in the register form (anon, `username` column only) | mobile `screens/Register.tsx`, `services/auth.ts`; Supabase grants + RLS instead of `/users/check-username` | type username, see taken/free | `services/auth.test.ts` | DONE |
| 5 | Email + phone verification | Email: real Supabase Auth OTP via custom SMTP (live). Phone: deferred — no SMS provider configured, so the app shows the stored number as **unverified** and calls no verification service (the Node dev phone route is reference-only and no longer used by mobile) | mobile `screens/Verify.tsx`, `services/auth.ts`; `services/api/src/domain/verificationService.ts` (reference) | register → verify email (real emailed OTP); phone shown unverified | mobile `auth.test.ts`, api `supabaseAuthProvider.test.ts` | DONE_DEMO_PROVIDER |
| 6 | Multiple text boxes + dropdowns | create-report form: text, textarea, date, selects | mobile `screens/CreateReport.tsx`, components | fill form, change dropdowns | posts API tests | DONE |
| 7 | Interactive real-time rating | 1–5 stars, upsert via RPC, live average via Supabase Realtime broadcast | `supabase/migrations/20260914200000_social_client_rpcs.sql`, `20260914210000_realtime_broadcast.sql` | rate; second session updates | `social.test.ts`, `realtime.test.ts` | DONE |
| 8 | Pagination | cursor-based feed + infinite scroll; mobile reads pages directly from Supabase (`findback_query_posts_client`, keyset cursor) | `supabase/migrations/20260914180000_client_post_reads.sql`, mobile `services/posts.ts`, `hooks/useFeed.ts`, `components/PostList.tsx` | scroll feed, load more | `posts.test.ts`, mobile `services/posts.test.ts` | DONE |
| 9 | Embedded external audio/video | YouTube URL, id extraction + iframe embed | mobile `components/YouTubeEmbed.tsx`, shared `extractYouTubeId` | paste YouTube link, play in post | unit validation tests | DONE |
| 10 | Google Maps / embedded map | one-time location picker + embedded map on post | mobile `components/LocationPicker.tsx`, `MapEmbed.tsx` | pin approximate location | — | DONE |
| 11 | Session/JWT auth | Mobile authenticates directly with Supabase Auth (email + password, publishable key) for the access JWT + rotating refresh token; the Node API retains Supabase token validation. Boot restore, single-flight 401 refresh/retry, logout; local JWT for tests/local | mobile `auth.tsx`, `services/auth.ts`, `services/supabaseClient.ts`, `services/api.ts`; API `auth/*`, `middleware/http.ts` | login/logout, restore session, inspect stored token | `auth.test.ts`, `authCutover.test.ts`, mobile `services/auth.test.ts` | DONE |
| 12 | On-device text-semantic Possible Matches | Local sentence embeddings + local cosine similarity (top 3, never a probability, no vector DB, no server AI); runs entirely on-device in the WebView with bundled weights; "Possible Matches" appears before publish | mobile `services/ml.ts` (text embeddings), `public/models/*`; create-report "Possible Matches" | attach photo → "Possible Matches" shows top 3 semantic matches before publishing | `ml.test.ts`, embedding + cosine unit tests | DONE |
| 13 | Image upload + cloud storage | On-device normalization (`apps/mobile/src/services/image.ts`) → direct Supabase Storage upload (`findback-images`, `<uid>/<uuid>.<ext>`) → owner-scoped `uploads` staging row bound by the create-post RPC; the legacy Node `/uploads` + `sharp` path is retained for the reference API and its tests | `apps/mobile/src/services/{image.ts,posts.ts}`; `supabase/migrations/20260914220000_direct_storage_uploads.sql`; `services/api/src/storage/*` (legacy) | attach photo, preview, publish; public image URL | mobile `image.test.ts`, `postsUpload.test.ts`; api `uploads.test.ts`, `supabaseStorageProvider.test.ts`, `imageNormalizer.test.ts` | DONE |
| 14 | Datepicker | native date input in create report | mobile `screens/CreateReport.tsx` | choose date | — | DONE |
| 15 | GSAP/Framer Motion animations | Framer Motion entrance + transitions | mobile `components/PostCard.tsx`, `screens/Splash.tsx`, `index.css` | open app, feed card entrance | — | DONE |
| 16 | SASS/Tailwind | Tailwind v4 theme tokens + utility classes | mobile `src/theme.tsx`, `index.css` | inspect classes/theme switch | — | DONE |
| 17 | Git + Vite workflow | Git repo + Vite web shell | repo root, `apps/mobile` | `git log`, `npm run build -w @findback/mobile` | — | DONE |
| 18 | GraphQL or modern API | Supabase GraphQL (`pg_graphql`) at `/graphql/v1`, resolving as the JWT role (grant- and RLS-filtered schema; no `users.email`/`phone`, anon sees no `item_postsCollection`); legacy GraphQL-Yoga retained as reference | `supabase/migrations/20260914230000_enable_pg_graphql.sql`; `docs/API_DEMO.md`; `services/api/src/graphql/*` (legacy) | GraphQL query for `item_postsCollection` / `usersCollection` with an access token | `docs/API_DEMO.md` live verification (14/14) | DONE |
| 19 | RESTful API | Supabase PostgREST / Data API (`/rest/v1`) — anon username lookup, authenticated feed RPC and table reads, RLS-enforced; legacy Express REST retained as reference | `docs/API_DEMO.md`; `services/api/src/app.ts` (legacy) | `GET /rest/v1/users?select=username&username=eq.…`; `POST /rest/v1/rpc/findback_query_posts_client` | `docs/API_DEMO.md` live verification (14/14) | DONE |
| 20 | Crystal Report | Reporting API (JSON/CSV) over Supabase PostgreSQL + ready-to-run report queries + setup doc; no `.rpt` (needs licensed Windows Crystal Reports) | `docs/reporting/REPORTING.md`, `/reports/activity`, `scripts/report-activity.mjs` | generate CSV → open in Excel/Crystal | `reporting.test.ts` | DEFERRED_EXTERNAL_TOOL |
| 21 | Modern frontend framework | React 19 web shell (Capacitor → APK) | `apps/mobile` | run app | mobile unit tests | DONE |
| 22 | Docker / CI/CD | Working Dockerized reference/demo image (legacy web shell + Node REST/GraphQL, SQLite mode) + compose; GitHub Actions CI on `main` runs lint/typecheck/tests/web build **and** a Docker job that builds the image, runs the container and passes the `/health` check (observed green). The Android app connects directly to hosted Supabase and does not require Docker. No local Docker engine in this environment, so the build/run proof is the CI job's | `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` | `docker compose up`; CI runs the same checks + Docker health check | GitHub Actions run `34880260112` (both jobs green) | DONE |
| 23 | Local VLM report assistant | On-device LiteRT-LM / SmolVLM2 (GPU delegate) generates a structured report from the selected photo; the Help Assistant (Edge Function `ai-help`) remains available as a secondary fallback | mobile `services/vlm.ts`, `public/models/smolvlm2/*`; create-report "Generate report" | attach photo → "Generate report" runs local VLM on GPU; Help Assistant still reachable from Profile | `vlm.test.ts` (structure only; GPU proof blocked on phone) | DONE_DEMO_PROVIDER |
| 24 | Task-specific deliverable | **TBD** (reserved; the only permitted `TBD` in the plan) — Android debug APK with on-device AI (text embeddings + VLM on GPU) | `apps/mobile/android/`, `npm run apk` | install `app-debug.apk` on a physical ARM64 device and run the walkthrough | APK build; physical run pending | NOT_DONE |

## Notes
- Allowed statuses are only `DONE`, `DONE_DEMO_PROVIDER`,
  `DEFERRED_EXTERNAL_PROVIDER`, `DEFERRED_EXTERNAL_TOOL`, `TODO`, `TBD`.
- `DONE_DEMO_PROVIDER` rows work end-to-end; the remaining non-production
  pieces are documented in `DEFERRED_DECISIONS.md` — currently **phone/SMS**,
  the optional paid **LLM key**, the licensed **Crystal `.rpt`**, and the **ARM64 phone pass** for on-device AI (GPU delegate proof, 256M readiness, photo-picker → VLM walkthrough).
- #20's `.rpt` design file needs the licensed Windows-only Crystal Reports
  designer; FindBack commits the reporting API, SQL queries, and CSV export so it
  imports cleanly against the Supabase PostgreSQL database (or the local SQLite
  demo).
- #24 is the only permitted `TBD` in the plan (reserved for the ARM64 phone pass).
- Verification evidence: API test suites (15 files / 134 tests), mobile unit
  tests (9 files / 96 tests), full typecheck/lint, the mobile production build,
  a locally built Android debug APK, and live E2E passes for Supabase Auth email
  OTP and direct-to-Supabase Storage image upload.
- Persistence has a Store seam: `SupabaseStore` (Data API) is the real
  application backend; in-memory SQLite is the test/local-demo backend. See
  `docs/DATABASE_MIGRATION.md`.
- The mobile app has **zero Node runtime dependency**: it is built with only
  `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` and talks exclusively to
  hosted Supabase. The Node Express/GraphQL/Socket.IO server is retained for the
  Docker image and as reference, not as an app dependency.
- **Overall deliverable**: the Android APK with on-device AI (text embeddings + VLM on GPU).
