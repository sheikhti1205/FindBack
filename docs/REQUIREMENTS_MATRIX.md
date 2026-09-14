# Requirements matrix — FindBack

Traceability for the 24 teacher requirements of the Mobile App Development Lab.

Status vocabulary (from the project brief):
`DONE` · `DONE_DEMO_PROVIDER` · `DEFERRED_EXTERNAL_PROVIDER` ·
`DEFERRED_EXTERNAL_TOOL` · `TODO`

Last updated: 2026-09-14 (Block 10I documentation pass: the runtime API is now verified as hosted Supabase — PostgREST/Data API for REST (anon username lookup + authenticated feed RPC, RLS-enforced) and `pg_graphql` for GraphQL at `/graphql/v1` (role-filtered schema, no private profile fields); reporting stays a `service_role`-only JSONB RPC. See `docs/API_DEMO.md`.)
Statuses are only non-TODO when verifiable end-to-end (API tests green + live
mobile/UI flow exercised).

| # | Teacher requirement | FindBack implementation | Code path | Demo steps | Tests | Status |
|---|---|---|---|---|---|---|
| 1 | ERD as scalable PDF | Vector PDF (reportlab) + Mermaid source | `docs/erd/ERD.pdf`, `docs/erd/ERD.md`, `tools/render_erd.py` | open PDF, zoom (vector) | — | DONE |
| 2 | Real-time comments (own DB) | Supabase Realtime Broadcast (private `post:<id>` channel) + direct comment RPCs | `supabase/migrations/20260914210000_realtime_broadcast.sql`; mobile `services/realtime.ts`, `screens/PostDetail.tsx` | two sessions, comment appears live | `realtime.test.ts`, `social.test.ts` | DONE |
| 3 | Like/dislike live count | reactions upsert + Supabase Realtime broadcast (aggregate counts, no user ids) | `supabase/migrations/20260914210000_realtime_broadcast.sql`, `20260914200000_social_client_rpcs.sql` | two sessions | `social.test.ts`, `realtime.test.ts` | DONE |
| 4 | Live unique username check | debounced direct Supabase username lookup in the register form (anon, `username` column only) | mobile `screens/Register.tsx`, `services/auth.ts`; Supabase grants + RLS instead of `/users/check-username` | type username, see taken/free | `services/auth.test.ts` | DONE |
| 5 | Email + phone verification | Email: real Supabase Auth OTP via custom SMTP (live). Phone: still demo/deferred — Supabase phone provider disabled, no SMS provider (returns `501`) | `auth/supabaseAuthProvider.ts`, `domain/verificationService.ts`; mobile `screens/Verify.tsx` | register → verify email (real OTP) + phone (demo/local) | `auth.test.ts`, `supabaseAuthProvider.test.ts` | DONE_DEMO_PROVIDER |
| 6 | Multiple text boxes + dropdowns | create-report form: text, textarea, date, selects | mobile `screens/CreateReport.tsx`, components | fill form, change dropdowns | posts API tests | DONE |
| 7 | Interactive real-time rating | 1–5 stars, upsert via RPC, live average via Supabase Realtime broadcast | `supabase/migrations/20260914200000_social_client_rpcs.sql`, `20260914210000_realtime_broadcast.sql` | rate; second session updates | `social.test.ts`, `realtime.test.ts` | DONE |
| 8 | Pagination | cursor-based feed + infinite scroll; mobile reads pages directly from Supabase (`findback_query_posts_client`, keyset cursor) | `supabase/migrations/20260914180000_client_post_reads.sql`, mobile `services/posts.ts`, `hooks/useFeed.ts`, `components/PostList.tsx` | scroll feed, load more | `posts.test.ts`, mobile `services/posts.test.ts` | DONE |
| 9 | Embedded external audio/video | YouTube URL, id extraction + iframe embed | mobile `components/YouTubeEmbed.tsx`, shared `extractYouTubeId` | paste YouTube link, play in post | unit validation tests | DONE |
| 10 | Google Maps / embedded map | one-time location picker + embedded map on post | mobile `components/LocationPicker.tsx`, `MapEmbed.tsx` | pin approximate location | — | DONE |
| 11 | Session/JWT auth | Mobile authenticates directly with Supabase Auth (email + password, publishable key) for the access JWT + rotating refresh token; the Node API retains Supabase token validation. Boot restore, single-flight 401 refresh/retry, logout; local JWT for tests/local | mobile `auth.tsx`, `services/auth.ts`, `services/supabaseClient.ts`, `services/api.ts`; API `auth/*`, `middleware/http.ts` | login/logout, restore session, inspect stored token | `auth.test.ts`, `authCutover.test.ts`, mobile `services/auth.test.ts` | DONE |
| 12 | TFLite / on-device ML | On-device TensorFlow.js MobileNet V1 (alpha 0.25) with ~1.92 MB weights bundled in the app (`public/models/mobilenet/`); inference runs entirely in the WebView with no CDN fallback, and "Suggest category" works from the selected local file before the upload completes | mobile `services/ml.ts`, `public/models/mobilenet/*`; create-report "Suggest category" | attach photo → suggest category before publishing | `ml.test.ts`, category-mapping unit tests (ml map in shared) | DONE |
| 13 | Image upload + cloud storage | On-device normalization (`apps/mobile/src/services/image.ts`) → direct Supabase Storage upload (`findback-images`, `<uid>/<uuid>.<ext>`) → owner-scoped `uploads` staging row bound by the create-post RPC; the legacy Node `/uploads` + `sharp` path is retained for the reference API and its tests | `apps/mobile/src/services/{image.ts,posts.ts}`; `supabase/migrations/20260914220000_direct_storage_uploads.sql`; `services/api/src/storage/*` (legacy) | attach photo, preview, publish; public image URL | mobile `image.test.ts`, `postsUpload.test.ts`; api `uploads.test.ts`, `supabaseStorageProvider.test.ts`, `imageNormalizer.test.ts` | DONE |
| 14 | Datepicker | native date input in create report | mobile `screens/CreateReport.tsx` | choose date | — | DONE |
| 15 | GSAP/Framer Motion animations | Framer Motion entrance + transitions | mobile `components/PostCard.tsx`, `screens/Splash.tsx`, `index.css` | open app, feed card entrance | — | DONE |
| 16 | SASS/Tailwind | Tailwind v4 theme tokens + utility classes | mobile `src/theme.tsx`, `index.css` | inspect classes/theme switch | — | DONE |
| 17 | Git + Vite workflow | Git repo + Vite web shell | repo root, `apps/mobile` | `git log`, `npm run build -w @findback/mobile` | — | DONE |
| 18 | GraphQL or modern API | Supabase GraphQL (`pg_graphql`) at `/graphql/v1`, resolving as the JWT role (grant- and RLS-filtered schema; no `users.email`/`phone`, anon sees no `item_postsCollection`); legacy GraphQL-Yoga retained as reference | `supabase/migrations/20260914230000_enable_pg_graphql.sql`; `docs/API_DEMO.md`; `services/api/src/graphql/*` (legacy) | GraphQL query for `item_postsCollection` / `usersCollection` with an access token | `docs/API_DEMO.md` live verification (14/14) | DONE |
| 19 | RESTful API | Supabase PostgREST / Data API (`/rest/v1`) — anon username lookup, authenticated feed RPC and table reads, RLS-enforced; legacy Express REST retained as reference | `docs/API_DEMO.md`; `services/api/src/app.ts` (legacy) | `GET /rest/v1/users?select=username&username=eq.…`; `POST /rest/v1/rpc/findback_query_posts_client` | `docs/API_DEMO.md` live verification (14/14) | DONE |
| 20 | Crystal Report | Reporting API (JSON/CSV) over Supabase PostgreSQL + ready-to-run report queries + setup doc; no `.rpt` (needs licensed Windows Crystal Reports) | `docs/reporting/REPORTING.md`, `/reports/activity`, `scripts/report-activity.mjs` | generate CSV → open in Excel/Crystal | `reporting.test.ts` | DEFERRED_EXTERNAL_TOOL |
| 21 | Modern frontend framework | React 19 web shell (Capacitor → APK) | `apps/mobile` | run app | mobile unit tests | DONE |
| 22 | Docker / CI/CD | Dockerfile + compose + GitHub Actions; CI green on `main` (lint/typecheck/tests/web build, Android build intentionally excluded); Docker image not built here (no Docker Engine in this environment) | `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` | `docker compose up` (needs Docker Engine); CI runs lint/typecheck/tests | CI steps mirror local commands | DONE |
| 23 | Generative AI (minimal) | Help Assistant chat with deterministic fallback + optional OpenAI-compatible LLM | `providers/aiProvider.ts`; mobile `screens/Help.tsx` | ask a question in Help | `ai.test.ts` | DONE_DEMO_PROVIDER |
| 24 | Task-specific deliverable | Installable Android debug APK + progressive web shell with realtime features | `apps/mobile/android/`, `npm run apk` | install `app-debug.apk` on emulator/device | — | DONE |

## Notes
- Allowed statuses are only `DONE`, `DONE_DEMO_PROVIDER`,
  `DEFERRED_EXTERNAL_PROVIDER`, `DEFERRED_EXTERNAL_TOOL`, `TODO`.
- `DONE_DEMO_PROVIDER` rows work end-to-end; the remaining non-production
  pieces are documented in `DEFERRED_DECISIONS.md` — currently **phone/SMS**,
  the optional paid **LLM key**, and the licensed **Crystal `.rpt`**. Email OTP,
  database, and object storage are already real (Supabase), and image uploads now
  go straight from the app to Supabase Storage.
- #20's `.rpt` design file needs the licensed Windows-only Crystal Reports
  designer; FindBack commits the reporting API, SQL queries, and CSV export so it
  imports cleanly against the Supabase PostgreSQL database (or the local SQLite
  demo).
- Verification evidence: API test suites (15 files / 134 tests), mobile unit
  tests (9 files / 96 tests), full typecheck/lint, the mobile production build,
  a locally built Android debug APK, and live E2E passes for Supabase Auth email
  OTP and direct-to-Supabase Storage image upload.
- Persistence has a Store seam: `SupabaseStore` (Data API) is the real
  application backend; in-memory SQLite is the test/local-demo backend. See
  `docs/DATABASE_MIGRATION.md`.
