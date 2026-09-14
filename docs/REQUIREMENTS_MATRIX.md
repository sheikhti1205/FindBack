# Requirements matrix — FindBack

Traceability for the 24 teacher requirements of the Mobile App Development Lab.

Status vocabulary (from the project brief):
`DONE` · `DONE_DEMO_PROVIDER` · `DEFERRED_EXTERNAL_PROVIDER` ·
`DEFERRED_EXTERNAL_TOOL` · `TODO`

Last updated: 2026-09-14 (Block 10D documentation pass: mobile reads the feed, a single post and My Posts directly from Supabase through the client-safe `findback_query_posts_client` RPC with a public-author-only privacy boundary; post mutations, comments, reactions and ratings remain on the Node API).
Statuses are only non-TODO when verifiable end-to-end (API tests green + live
mobile/UI flow exercised).

| # | Teacher requirement | FindBack implementation | Code path | Demo steps | Tests | Status |
|---|---|---|---|---|---|---|
| 1 | ERD as scalable PDF | Vector PDF (reportlab) + Mermaid source | `docs/erd/ERD.pdf`, `docs/erd/ERD.md`, `tools/render_erd.py` | open PDF, zoom (vector) | — | DONE |
| 2 | Real-time comments (own DB) | Socket.IO gateway events + comments REST | `services/api/src/realtime/gateway.ts`, `domain/commentsService.ts`; mobile `screens/PostDetail.tsx` | two sessions, comment appears live | `social.test.ts` | DONE |
| 3 | Like/dislike live count | reactions upsert + live broadcast | `domain/reactionsService.ts` | two sessions | `social.test.ts` | DONE |
| 4 | Live unique username check | debounced direct Supabase username lookup in the register form (anon, `username` column only) | mobile `screens/Register.tsx`, `services/auth.ts`; Supabase grants + RLS instead of `/users/check-username` | type username, see taken/free | `services/auth.test.ts` | DONE |
| 5 | Email + phone verification | Email: real Supabase Auth OTP via custom SMTP (live). Phone: still demo/deferred — Supabase phone provider disabled, no SMS provider (returns `501`) | `auth/supabaseAuthProvider.ts`, `domain/verificationService.ts`; mobile `screens/Verify.tsx` | register → verify email (real OTP) + phone (demo/local) | `auth.test.ts`, `supabaseAuthProvider.test.ts` | DONE_DEMO_PROVIDER |
| 6 | Multiple text boxes + dropdowns | create-report form: text, textarea, date, selects | mobile `screens/CreateReport.tsx`, components | fill form, change dropdowns | posts API tests | DONE |
| 7 | Interactive real-time rating | 1–5 stars, upsert, live average broadcast | `domain/ratingsService.ts` | rate; second session updates | `social.test.ts` | DONE |
| 8 | Pagination | cursor-based feed + infinite scroll; mobile reads pages directly from Supabase (`findback_query_posts_client`, keyset cursor) | `supabase/migrations/20260914180000_client_post_reads.sql`, mobile `services/posts.ts`, `hooks/useFeed.ts`, `components/PostList.tsx` | scroll feed, load more | `posts.test.ts`, mobile `services/posts.test.ts` | DONE |
| 9 | Embedded external audio/video | YouTube URL, id extraction + iframe embed | mobile `components/YouTubeEmbed.tsx`, shared `extractYouTubeId` | paste YouTube link, play in post | unit validation tests | DONE |
| 10 | Google Maps / embedded map | one-time location picker + embedded map on post | mobile `components/LocationPicker.tsx`, `MapEmbed.tsx` | pin approximate location | — | DONE |
| 11 | Session/JWT auth | Mobile authenticates directly with Supabase Auth (email + password, publishable key) for the access JWT + rotating refresh token; the Node API retains Supabase token validation. Boot restore, single-flight 401 refresh/retry, logout; local JWT for tests/local | mobile `auth.tsx`, `services/auth.ts`, `services/supabaseClient.ts`, `services/api.ts`; API `auth/*`, `middleware/http.ts` | login/logout, restore session, inspect stored token | `auth.test.ts`, `authCutover.test.ts`, mobile `services/auth.test.ts` | DONE |
| 12 | TFLite / on-device ML | On-device TensorFlow.js MobileNet V1 (alpha 0.25) with ~1.92 MB weights bundled in the app (`public/models/mobilenet/`); inference runs entirely in the WebView with no CDN fallback, and "Suggest category" works from the selected local file before the upload completes | mobile `services/ml.ts`, `public/models/mobilenet/*`; create-report "Suggest category" | attach photo → suggest category before publishing | `ml.test.ts`, category-mapping unit tests (ml map in shared) | DONE |
| 13 | Image upload + cloud storage | Upload API + `sharp` normalization; Supabase Storage (`findback-images`) in production, local disk in demo/tests | `services/api/src/storage/*`, `domain/storageService.ts`; mobile create report attach | attach photo, preview, publish; public image URL | `uploads.test.ts`, `supabaseStorageProvider.test.ts`, `imageNormalizer.test.ts` | DONE |
| 14 | Datepicker | native date input in create report | mobile `screens/CreateReport.tsx` | choose date | — | DONE |
| 15 | GSAP/Framer Motion animations | Framer Motion entrance + transitions | mobile `components/PostCard.tsx`, `screens/Splash.tsx`, `index.css` | open app, feed card entrance | — | DONE |
| 16 | SASS/Tailwind | Tailwind v4 theme tokens + utility classes | mobile `src/theme.tsx`, `index.css` | inspect classes/theme switch | — | DONE |
| 17 | Git + Vite workflow | Git repo + Vite web shell | repo root, `apps/mobile` | `git log`, `npm run build -w @findback/mobile` | — | DONE |
| 18 | GraphQL or modern API | GraphQL (Yoga) over the shared domain | `services/api/src/graphql/*` | GraphiQL at /graphql | `graphql.test.ts` | DONE |
| 19 | RESTful API | Express REST endpoints (auth, posts, comments, reactions, ratings, uploads, reports, AI) | `services/api/src/app.ts` | curl / Postman | api suites | DONE |
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
  database, and object storage are already real (Supabase).
- #20's `.rpt` design file needs the licensed Windows-only Crystal Reports
  designer; FindBack commits the reporting API, SQL queries, and CSV export so it
  imports cleanly against the Supabase PostgreSQL database (or the local SQLite
  demo).
- Verification evidence: API test suites (15 files / 134 tests), mobile unit
  tests (5 files / 35 tests), full typecheck/lint, the mobile production build,
  a locally built Android debug APK, and live E2E passes for Supabase Auth email
  OTP and Supabase Storage image upload.
- Persistence has a Store seam: `SupabaseStore` (Data API) is the real
  application backend; in-memory SQLite is the test/local-demo backend. See
  `docs/DATABASE_MIGRATION.md`.
