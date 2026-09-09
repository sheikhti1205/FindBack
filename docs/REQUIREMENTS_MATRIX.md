# Requirements matrix — FindBack

Traceability for the 24 teacher requirements of the Mobile App Development Lab.

Status vocabulary (from the project brief):
`DONE` · `DONE_DEMO_PROVIDER` · `DEFERRED_EXTERNAL_PROVIDER` ·
`DEFERRED_EXTERNAL_TOOL` · `TODO`

Last updated: 2026-09-09 (start of Phase 1). Statuses are set only when a
requirement is verifiable end-to-end (API + mobile UI where applicable).

| # | Teacher requirement | FindBack implementation | Code path | Demo steps | Tests | Status |
|---|---|---|---|---|---|---|
| 1 | ERD as scalable PDF | Mermaid source + SVG + PDF export | `docs/erd/` | show vector PDF | — | TODO |
| 2 | Real-time comments (own DB) | Socket.IO gateway events + comments API | `services/api/src/realtime/*`, `domain/commentsService.ts` | two sessions, comment appears live | `social.test.ts` (events) | TODO |
| 3 | Like/dislike live count | reactions upsert + live broadcast | `domain/reactionsService.ts` | two sessions | `social.test.ts` | TODO |
| 4 | Live unique username check | debounced REST check | `/users/check-username`, mobile register form | type username, see taken/free | `auth.test.ts` | TODO |
| 5 | Email + phone verification | dev verification adapter + OTP UI state machine | `domain/verificationService.ts`, mobile verify screens | register → verify email + phone | `auth.test.ts` | TODO |
| 6 | Multiple text boxes + dropdowns | Create-report + profile forms | mobile `features/reports` | fill form, add dropdowns | posts API tests | TODO |
| 7 | Interactive real-time rating | 1-5 stars, upsert, live average | `domain/ratingsService.ts` | rate, second session updates | `social.test.ts` | TODO |
| 8 | Pagination | cursor pagination (REST + GraphQL) | `domain/postsService.ts` feed | scroll feed, load more | `posts.test.ts` | TODO |
| 9 | Embedded external audio/video | YouTube URL + iframe player | mobile `features/media`, shared `extractYouTubeId` | paste YouTube link, play embed | unit validation tests | TODO |
| 10 | Google Maps / embedded map | one-time map picker + embedded display | mobile `features/maps` | pin approximate location | — | TODO |
| 11 | Session/JWT auth | JWT login/register + protected routes | `domain/authService.ts`, middleware | login, inspect token, logout | `auth.test.ts` | TODO |
| 12 | TFLite / on-device ML | TensorFlow.js MobileNet → category map | mobile `features/ml` | photo → suggested category | category-mapping unit tests | TODO |
| 13 | Image upload + cloud storage | local storage adapter (swappable cloud) | `domain/storageService.ts`, mobile upload UI | attach photo to post | uploads REST | TODO |
| 14 | Datepicker | native date input in create report | mobile `features/reports` | choose date | — | TODO |
| 15 | GSAP/Framer Motion animations | Framer Motion transitions/feedback | mobile app-wide | open screens, like button | — | TODO |
| 16 | SASS/Tailwind | Tailwind tokens/theme | mobile `src/theme`, CSS | show Tailwind classes | — | TODO |
| 17 | Git + Vite workflow | Git repo + Vite build | repo root, `apps/mobile` | show git log / vite | — | DONE |
| 18 | GraphQL or modern API | GraphQL (Yoga) layer over shared domain | `services/api/src/graphql` | run a query in GraphiQL | `graphql.test.ts` | TODO |
| 19 | RESTful API | Express REST endpoints | `services/api/src/app.ts` | curl/API demo | api tests | TODO |
| 20 | Crystal Report | reporting data query + setup docs (`.rpt` external tool) | `docs/reporting/` | show report data export | — | TODO |
| 21 | Modern frontend framework | React | mobile | app runs | — | TODO |
| 22 | Docker / CI/CD | Dockerfile + compose + GitHub Actions | `docker-compose.yml`, `.github/workflows/` | run CI, build container | — | TODO |
| 23 | Generative AI (minimal) | AI Help Assistant (fallback + LLM adapter) | `providers/aiProvider.ts`, mobile help chat | ask help questions | `ai.test.ts` | TODO |
| 24 | Task-specific (TBD) | architecture room kept; no premature lock-in | repo layout | — | — | TODO |

## Notes
- Allowed statuses are only `DONE`, `DONE_DEMO_PROVIDER`,
  `DEFERRED_EXTERNAL_PROVIDER`, `DEFERRED_EXTERNAL_TOOL`, `TODO`. A row is only
  flipped to a non-TODO status once it is verifiable end-to-end (API + mobile).
- Provider-deferred rows will end as `DONE_DEMO_PROVIDER` or
  `DEFERRED_EXTERNAL_PROVIDER` with exact wiring instructions in the docs.
