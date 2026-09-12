# Requirements matrix — FindBack

Traceability for the 24 teacher requirements of the Mobile App Development Lab.

Status vocabulary (from the project brief):
`DONE` · `DONE_DEMO_PROVIDER` · `DEFERRED_EXTERNAL_PROVIDER` ·
`DEFERRED_EXTERNAL_TOOL` · `TODO`

Last updated: 2026-09-12 (Supabase database migration prep; no requirement status changed).
Statuses are only non-TODO when verifiable end-to-end (API tests green + live
mobile/UI flow exercised).

| # | Teacher requirement | FindBack implementation | Code path | Demo steps | Tests | Status |
|---|---|---|---|---|---|---|
| 1 | ERD as scalable PDF | Vector PDF (reportlab) + Mermaid source | `docs/erd/ERD.pdf`, `docs/erd/ERD.md`, `tools/render_erd.py` | open PDF, zoom (vector) | — | DONE |
| 2 | Real-time comments (own DB) | Socket.IO gateway events + comments REST | `services/api/src/realtime/gateway.ts`, `domain/commentsService.ts`; mobile `screens/PostDetail.tsx` | two sessions, comment appears live | `social.test.ts` | DONE |
| 3 | Like/dislike live count | reactions upsert + live broadcast | `domain/reactionsService.ts` | two sessions | `social.test.ts` | DONE |
| 4 | Live unique username check | debounced REST check in register form | `services/api` `/users/check-username`; mobile `screens/Register.tsx` | type username, see taken/free | `auth.test.ts` | DONE |
| 5 | Email + phone verification | OTP challenge state machine; dev provider echoes codes | `domain/verificationService.ts`, `providers/devVerification*`; mobile `screens/Verify.tsx` | register → verify email + phone | `auth.test.ts` | DONE_DEMO_PROVIDER |
| 6 | Multiple text boxes + dropdowns | create-report form: text, textarea, date, selects | mobile `screens/CreateReport.tsx`, components | fill form, change dropdowns | posts API tests | DONE |
| 7 | Interactive real-time rating | 1–5 stars, upsert, live average broadcast | `domain/ratingsService.ts` | rate; second session updates | `social.test.ts` | DONE |
| 8 | Pagination | cursor-based feed + infinite scroll | `domain/postsService.ts` (feed), `hooks/useFeed.ts`, `components/PostList.tsx` | scroll feed, load more | `posts.test.ts` | DONE |
| 9 | Embedded external audio/video | YouTube URL, id extraction + iframe embed | mobile `components/YouTubeEmbed.tsx`, shared `extractYouTubeId` | paste YouTube link, play in post | unit validation tests | DONE |
| 10 | Google Maps / embedded map | one-time location picker + embedded map on post | mobile `components/LocationPicker.tsx`, `MapEmbed.tsx` | pin approximate location | — | DONE |
| 11 | Session/JWT auth | JWT login/register, guarded routes, token storage | `domain/authService.ts`, `middleware/http.ts`; mobile `auth.tsx` | login/logout, inspect stored token | `auth.test.ts` | DONE |
| 12 | TFLite / on-device ML | on-device TensorFlow.js MobileNet → category suggestion | mobile `services/ml.ts`; create-report "Suggest category" | photo → suggested category | category-mapping unit tests (ml map in shared) | DONE_DEMO_PROVIDER |
| 13 | Image upload + cloud storage | upload API + local storage adapter (cloud swappable) | `domain/storageService.ts`, `recordUpload`; mobile create report attach | attach photo, preview, publish | uploads REST (posts tests) | DONE_DEMO_PROVIDER |
| 14 | Datepicker | native date input in create report | mobile `screens/CreateReport.tsx` | choose date | — | DONE |
| 15 | GSAP/Framer Motion animations | Framer Motion entrance + transitions | mobile `components/PostCard.tsx`, `screens/Splash.tsx`, `index.css` | open app, feed card entrance | — | DONE |
| 16 | SASS/Tailwind | Tailwind v4 theme tokens + utility classes | mobile `src/theme.tsx`, `index.css` | inspect classes/theme switch | — | DONE |
| 17 | Git + Vite workflow | Git repo + Vite web shell | repo root, `apps/mobile` | `git log`, `npm run build -w @findback/mobile` | — | DONE |
| 18 | GraphQL or modern API | GraphQL (Yoga) over the shared domain | `services/api/src/graphql/*` | GraphiQL at /graphql | `graphql.test.ts` | DONE |
| 19 | RESTful API | Express REST endpoints (auth, posts, comments, reactions, ratings, uploads, reports, AI) | `services/api/src/app.ts` | curl / Postman | api suites | DONE |
| 20 | Crystal Report | Reporting API (JSON/CSV) + ready-to-run report queries + setup doc | `docs/reporting/REPORTING.md`, `/reports/activity`, `scripts/report-activity.mjs` | generate CSV → open in Excel/Crystal | `reporting.test.ts` | DEFERRED_EXTERNAL_TOOL |
| 21 | Modern frontend framework | React 19 web shell (Capacitor → APK) | `apps/mobile` | run app | mobile unit tests | DONE |
| 22 | Docker / CI/CD | Dockerfile + compose + GitHub Actions workflow | `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml` | `docker compose up` (needs Docker Engine); CI runs lint/typecheck/tests | CI steps mirror local commands | DONE |
| 23 | Generative AI (minimal) | Help Assistant chat with deterministic fallback + optional OpenAI-compatible LLM | `providers/aiProvider.ts`; mobile `screens/Help.tsx` | ask a question in Help | `ai.test.ts` | DONE_DEMO_PROVIDER |
| 24 | Task-specific deliverable | Installable Android debug APK + progressive web shell with realtime features | `apps/mobile/android/`, `npm run apk` | install `app-debug.apk` on emulator/device | — | DONE |

## Notes
- Allowed statuses are only `DONE`, `DONE_DEMO_PROVIDER`,
  `DEFERRED_EXTERNAL_PROVIDER`, `DEFERRED_EXTERNAL_TOOL`, `TODO`.
- `DONE_DEMO_PROVIDER` rows work end-to-end with a demo provider; the exact
  production wiring (email/SMS gateway, cloud object storage, paid LLM) is
  documented in `DEFERRED_DECISIONS.md`.
- #20's `.rpt` design file needs the licensed Windows-only Crystal Reports
  designer; FindBack commits the data layer and queries so it imports cleanly.
- Verification evidence: API test suites (8 files / 44 tests), mobile unit
  tests, mobile production build, and a live browser E2E pass (sign-in, feed,
  comments with live dedupe, ratings, reactions, map embed).
- Persistence now has a provider seam: `DB_PROVIDER=sqlite` (default/local demo)
  or `postgres` (Supabase adapter + migration, not yet applied). See
  `docs/DATABASE_MIGRATION.md`.
