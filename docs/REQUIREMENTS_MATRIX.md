# Requirements matrix — FindBack

Traceability for the 24 teacher requirements of the Mobile App Development Lab.

Status vocabulary (from the project brief):
`DONE` · `DONE_DEMO_PROVIDER` · `DEFERRED_EXTERNAL_PROVIDER` ·
`DEFERRED_EXTERNAL_TOOL` · `NOT_DONE` · `TODO`

Last updated: 2026-09-25 (OpenRouter-only pivot: the active build removed the
local generative runtime — no bundled/on-device VLM, no SmolVLM2 downloads, no
GPU/CPU model modes — and routes optional AI through the OpenRouter free route
(`openrouter/free`) with the user's own key. On-device **text embeddings** for
Possible Matches are retained. Verified local gates at that commit: typecheck,
lint, mobile + API unit suites, web build, Android JVM + `assembleDebug`, strict
APK scan and release-config check. Live OpenRouter key and physical-device
passes remain owner-run.)
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
| 12 | On-device text-semantic Possible Matches | Local sentence embeddings via the native bridge to the MediaPipe TextEmbedder asset (`models/use/universal_sentence_encoder.tflite`) + local cosine similarity (top 3, never a probability, no vector DB, no server AI). This non-generative similarity bridge is **retained** by the pivot and is independent of cloud AI; generative suggestions moved off-device (see #23). "Possible Matches" renders on the post-detail screen for open posts | mobile `services/embeddings.ts` (native bridge), native `UniversalSentenceEmbedder.kt`; post-detail "Possible Matches" | attach photo → publish → open the post to see top-3 semantic matches | `possibleMatches.test.ts`, `PossibleMatches.test.tsx`, embedding + cosine unit tests | DONE |
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
| 23 | Local VLM report assistant | **v0.6 truth (replaces the 2026-09-25 cloud-only pivot note).** The create-report photo assistant is consented SmolVLM2 on-device default with OpenRouter free-route (`openrouter/free`) cloud fallback (user's own key): photo suggestions return review-only title/category/description cards with per-field Apply/Keep and a replace-confirm before touching typed fields; unreleased categories are dropped, never auto-applied. Help chat is cloud (OpenRouter free default, built-in fallback when no key) plus installed Needle/SmolVLM2 where wired. Matching stays USE on-device default with installed Needle as the explicit session challenger. Physical-device proof remains NOT EXECUTED (see gate-e runbook) | mobile `services/analyzeReportPhoto.ts`, `services/analyzeReportPhotoLocal.ts`, `services/openRouter.ts`, `services/assistant/cloudAssistant.ts`, `services/aiCredentials.ts`, `components/VlmSuggestions.tsx`; create-report "Analyze photo" | install SmolVLM2 → attach photo → "Analyze photo" → consent → local-first suggestions with Apply/Keep review; without the local model, cloud fallback with key; ask AI Help | `openRouter.test.ts`, `cloudAssistant.test.ts`, `noLegacyAiRoute.test.ts`, `appCapabilities.test.ts` | DONE_DEMO_PROVIDER (live key + device pass owner-pending) |
| 24 | Task-specific deliverable | **TBD** (reserved; the only permitted `TBD` in the plan) — Android debug APK with **on-device text embeddings** (Possible Matches) and optional **cloud** generative AI via the OpenRouter free route with the user's own key; no bundled/on-device generative model | `apps/mobile/android/`, `npm run apk` | install `app-debug.apk` on a physical ARM64 device and run the walkthrough (core flows without a key; connect key for Help/photo AI) | APK build + release-config + strict APK scan gates; **physical install + live-key pass pending owner** | NOT_DONE |

## Notes
- Allowed statuses are only `DONE`, `DONE_DEMO_PROVIDER`,
  `DEFERRED_EXTERNAL_PROVIDER`, `DEFERRED_EXTERNAL_TOOL`, `TODO`, `TBD`.
- `DONE_DEMO_PROVIDER` rows work end-to-end; the remaining non-production
   pieces are documented in `DEFERRED_DECISIONS.md` — currently **phone/SMS**,
   the licensed **Crystal `.rpt`**, the **live OpenRouter key** pass, and the
   **ARM64 phone pass** for on-device **text embeddings** device proof, plus the
   Civi 3 native AI device matrix (SmolVLM2/Needle install, CPU/GPU measure,
   matching arms) which remains NOT EXECUTED per the gate-e runbook.
- #20's `.rpt` design file needs the licensed Windows-only Crystal Reports
  designer; FindBack commits the reporting API, SQL queries, and CSV export so it
  imports cleanly against the Supabase PostgreSQL database (or the local SQLite
  demo).
- #24 is the only permitted `TBD` in the plan (reserved for the ARM64 phone pass).
- Verification evidence: API test suites, mobile unit suites, full
  typecheck/lint, the mobile production build, a locally built Android debug APK
  with the strict APK scan and release-config check, and live E2E passes for
  Supabase Auth email OTP and direct-to-Supabase Storage image upload. The
  OpenRouter responses in automated tests are mocked; a **live-key pass** and a
  **physical-device walkthrough** remain owner-run and unverified here.
- Persistence has a Store seam: `SupabaseStore` (Data API) is the real
  application backend; in-memory SQLite is the test/local-demo backend. See
  `docs/DATABASE_MIGRATION.md`.
- The mobile app has **zero Node runtime dependency**: it is built with only
  `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` and talks exclusively to
  hosted Supabase. The Node Express/GraphQL/Socket.IO server is retained for the
  Docker image and as reference, not as an app dependency.
- **Overall deliverable**: the Android APK with on-device **text-embedding** Possible Matches and optional cloud AI through the OpenRouter free route (user-owned key).
