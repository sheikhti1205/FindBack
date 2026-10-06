# Requirements matrix — FindBack

24 teacher requirements, reconciled 2026-10-06 against source/audit baseline
`b472a247ae593b8eb4e9585bb8947a87ccfaf6c7`. Concurrent main-owned implementation
is **IN_PROGRESS** until its returned evidence is reviewed. **Release: HOLD.**

## Status vocabulary (two independent axes)

- Implementation: **IMPLEMENTED** (source/artifact exists), **PARTIAL** (required
  capability missing), **IN_PROGRESS** (owner implementing; not accepted),
  **EXTERNAL_BLOCKED** (required proprietary deliverable/tool unavailable).
- Verification: **SOURCE_REVIEWED** (paths checked, not execution),
  **AUDIT_REPORTED** (automated evidence supplied in 2026-10-05 audit, not rerun
  here), **HISTORICAL_LIVE** (earlier live proof, not final-candidate proof),
  **NOT_EXECUTED** (required acceptance run absent), **BLOCKED** (specific
  prerequisite absent). The verification column identifies each applicable scope.

There is no unqualified `DONE` status. Source, mocked tests, old live proof and
device acceptance are different evidence classes. An IMPLEMENTED row is not a
completed release requirement. See [current report](FINAL_ACCEPTANCE_REPORT.md),
[all findings](COMPLETION_AUDIT.md) and [demo/evidence steps](DEMO_CHECKLIST.md).
Main owns the upcoming `completion-ledger.json`; this document does not claim it
exists or that a whole-app completion gate has run.

Paths below are repo-relative; mobile paths use `apps/mobile/src/`.
Test filenames identify available coverage, **not fresh passing executions**.

| # | Teacher requirement | Current implementation / source paths | Implementation | Verification and exact remaining acceptance |
|---|---|---|---|---|
| 1 | ERD as scalable PDF | `docs/erd/ERD.pdf`, Mermaid `docs/erd/ERD.md`, `tools/render_erd.py`. Vector artifact present. | IMPLEMENTED | SOURCE_REVIEWED: files present. NOT_EXECUTED: fresh visual/vector zoom and schema-convergence review for submission. |
| 2 | Real-time comments (own DB) | Mobile `services/posts.ts` comment RPCs, `services/realtime.ts` private post/inbox Broadcast, `screens/PostDetail.tsx`; migrations `20260914210000_realtime_broadcast.sql`, `20261002030000_nested_comments.sql`. Tests: `realtime.test.ts`, post/detail suites. | IMPLEMENTED | HISTORICAL_LIVE: two-client proof in archived report. NOT_EXECUTED: final two-account/device comments, nested replies, reconnect and authorization smoke. |
| 3 | Like/dislike live count | `services/posts.ts` → `findback_react_client`, aggregate social state; `services/realtime.ts`; social RPC/Broadcast migrations. Tests: `services/posts.test.ts`, `services/realtime.test.ts`. | IMPLEMENTED | HISTORICAL_LIVE: earlier aggregate updates. NOT_EXECUTED: final two-client counts/remove/account isolation. |
| 4 | Live unique username check | `screens/Register.tsx`, `services/auth.ts` debounced anonymous username-only lookup; `20260914170000_username_availability_lookup.sql`. Tests: `Register.test.tsx`, `services/auth.test.ts`. | IMPLEMENTED | HISTORICAL_LIVE: API demo 14/14 includes lookup. NOT_EXECUTED: final register race, taken/free, case and literal-underscore behavior. |
| 5 | Email + phone verification | Email Supabase OTP/session via `services/auth.ts`, `auth.tsx`, `screens/Verify.tsx`. Baseline PHONE is stored/unverified; main-owned phone send/resend/verify integration is being implemented. Reference Node dev OTP does not satisfy SMS. | IN_PROGRESS | HISTORICAL_LIVE: real email OTP only. BLOCKED: hosted SMS provider/configuration and authorized number; live send/resend/verify/invalid-expired/cooldown/throttle/change/isolation proof missing (FBA-005). |
| 6 | Multiple text boxes + dropdowns | `screens/CreateReport.tsx`, `components/Fields.tsx`, `CategoryField.tsx`, rich-text description, title/type/category/date/location inputs. Tests: CreateReport suites, `Fields.test.tsx`, `CategoryField.test.tsx`. | IMPLEMENTED | SOURCE_REVIEWED. NOT_EXECUTED: final device validation, keyboard, category and draft preservation walkthrough. |
| 7 | Interactive real-time rating | `services/posts.ts` → `findback_rate_client`, social-state RPC; PostDetail stars and private Broadcast; social migrations. Tests: posts/realtime/PostDetail suites. | IMPLEMENTED | HISTORICAL_LIVE: earlier rating/average updates. NOT_EXECUTED: final two-account upsert/average/reconnect smoke. |
| 8 | Pagination | `services/posts.ts` keyset feed RPC (including nearby), `hooks/useFeed.ts`, `components/PostList.tsx`; client-post-read/feed migrations. Tests: `services/posts.test.ts`, `hooks/useFeed.test.ts`. | IMPLEMENTED | SOURCE_REVIEWED; HISTORICAL_LIVE: feed RPC. NOT_EXECUTED: final device filters, page boundaries, refresh and duplicate/order checks. |
| 9 | Embedded external audio/video | `components/YouTubeEmbed.tsx`, shared `extractYouTubeId`, CreateReport/PostDetail. Tests: embed/shared validation suites. This is YouTube video, not a generic arbitrary-media player. | IMPLEMENTED | SOURCE_REVIEWED. NOT_EXECUTED: valid/invalid URL, playback and WebView external-media behavior. |
| 10 | Google Maps / embedded map | `components/LocationPicker.tsx`, `MapPickerSheet.tsx`, keyless Google `MapEmbed.tsx`; native/browser location adapter, approximate/exact pin and manual/Maps-link input. Tests: LocationPicker/MapPickerSheet/location suites. | IMPLEMENTED | SOURCE_REVIEWED. NOT_EXECUTED: device permissions/services-off/coarse/manual paths; FBA-021 timing flake needs repeated deterministic proof. |
| 11 | Session/JWT auth | Direct Supabase Auth access/rotating refresh session; `auth.tsx`, `services/auth.ts`, `supabaseClient.ts`, `screens/AccountSettings.tsx`, `services/aiCredentials.ts` logout purge. Tests: auth/AccountSettings/credential suites. Node JWT is reference-only. | IMPLEMENTED | HISTORICAL_LIVE: restore/login/email. AUDIT_REPORTED: b472a24 logout session/remembered-key purge, failure resilience, sibling isolation (FBA-031). NOT_EXECUTED: final device restore/logout/relogin/account switch. |
| 12 | On-device text-semantic Possible Matches | `services/embeddings.ts` → native `UniversalSentenceEmbedder.kt` / pinned USE asset; `services/possibleMatches.ts`, `similarity.ts`, `components/PossibleMatches.tsx`. USE default; installed Needle explicit session challenger, no server inference/vector DB; top 3, never probability. Tests: possibleMatches/embedding/similarity/component suites. | IMPLEMENTED | SOURCE_REVIEWED. NOT_EXECUTED: physical native vectors/ranking/offline proof and accepted calibration/baseline (FBA-002/013/014). Fetching candidates still requires data connectivity or available cache; local scoring is not full offline data access. |
| 13 | Image upload + cloud storage | `services/image.ts`, `postsUpload.ts`, `posts.ts`; direct normalized photos to owner `<uid>/` Storage staging, publish/reorder/remove; direct-storage/multi-image migrations. Node sharp/upload remains reference. Tests: image/postsUpload/CreateReport multi-image suites. | IMPLEMENTED | HISTORICAL_LIVE: earlier Storage 20/20, not current multi-image/device proof. NOT_EXECUTED: final picker/camera/permissions/normalization/upload failures/ownership; Xiaomi fixture gap FBA-016 remains. |
| 14 | Datepicker | `screens/CreateReport.tsx` → `components/ReportDatePicker.tsx`, calendar date validation and future-date refusal. Tests: ReportDatePicker/CreateReport/date utilities. | IMPLEMENTED | SOURCE_REVIEWED. NOT_EXECUTED: device picker, locale, keyboard and invalid/future date smoke. |
| 15 | GSAP/Framer Motion animations | Framer Motion `components/PostCard.tsx`, `RouteTransition.tsx`, `screens/Splash.tsx`, shared `uiMotion` + reduced-motion preference. GSAP not required as second library. Tests: motion/appearance/component suites. | IMPLEMENTED | SOURCE_REVIEWED. NOT_EXECUTED: reduced-motion, focus and device transition acceptance; no flake-free claim (FBA-021). |
| 16 | SASS/Tailwind | Tailwind v4 import/tokens in `index.css`, `theme.tsx`, appearance settings/utilities. Tests: appearance/theme/contrast suites. | IMPLEMENTED | SOURCE_REVIEWED. NOT_EXECUTED: device light/dark/AMOLED/accent/large-text contrast and accessibility pass. |
| 17 | Git + Vite workflow | Git repository, Vite workspace `apps/mobile/package.json`, `vite.config.ts`. | IMPLEMENTED | AUDIT_REPORTED: exact baseline Web run 37348171827 green. NOT_EXECUTED: final-SHA config-asserted build and bundle URL proof; never build without nonempty public Supabase URL/publishable key. |
| 18 | GraphQL or modern API | Supabase `/graphql/v1` `pg_graphql`, JWT-role grants/RLS; `20260914230000_enable_pg_graphql.sql`, `docs/API_DEMO.md`. GraphQL-Yoga is reference-only. | IMPLEMENTED | HISTORICAL_LIVE: API demo 14/14. NOT_EXECUTED: final grants/schema/privacy/advisor recheck after migrations; no phone/email exposure. |
| 19 | RESTful API | Supabase PostgREST `/rest/v1`, authenticated feed/write RPCs, anonymous username lookup; mobile `services/posts.ts`/`auth.ts`, client RPC migrations, `docs/API_DEMO.md`. Express reference only. | IMPLEMENTED | HISTORICAL_LIVE: API demo 14/14. NOT_EXECUTED: final role/ownership checks and core device/data walkthrough. |
| 20 | Crystal Report | `services/api/src/domain/reportingService.ts`, reporting route/tests, `scripts/report-activity.mjs`, `docs/reporting/REPORTING.md`: JSON/CSV/SQL only. No genuine `.rpt`. | EXTERNAL_BLOCKED | BLOCKED: licensed Windows Crystal Reports designer/operator and permitted dataset/connection required to create/open/render real artifact (FBA-006), or explicit evaluator acceptance of substitute. Renaming CSV to `.rpt` is not evidence. |
| 21 | Modern frontend framework | React 19 + TypeScript/Vite shell, Capacitor Android packaging; `apps/mobile/src/App.tsx` and workspace dependencies. | IMPLEMENTED | AUDIT_REPORTED: baseline mobile suite 3330 reported passes. NOT_EXECUTED: final framework/build/device shell smoke; test count is dated evidence, not completion. |
| 22 | Docker / CI/CD | `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml`; Docker reference/demo + Node/SQLite, not APK runtime dependency. | IMPLEMENTED | HISTORICAL_LIVE: Docker build/run/health CI run 34880260112 in old report. AUDIT_REPORTED: b472a24 CI run 37348171843. NOT_EXECUTED: all final-SHA critical workflows/security/release checks (FBA-022/023). |
| 23 | Local VLM report assistant | `services/analyzeReportPhoto.ts`, `analyzeReportPhotoLocal.ts`, AI application manager, `components/VlmSuggestions.tsx`, CreateReport. Automatic SmolVLM2 local-first with consented OpenRouter fallback; on-device-only never sends; cloud-only skips local. CPU default/first-class, GPU vision measured only, CPU decoder on both arms. Review Apply/Keep/replace-confirm. Photo grounding UI and assistant modes are main-owned integration work, not deferred scope. | IN_PROGRESS | SOURCE_REVIEWED: photo transport/review paths. AUDIT_REPORTED: AI gate 12/12 + 64/64, OpenRouter-only live-tested marker. NOT_EXECUTED: returned grounding/mode UI regression evidence, actual device/model lifecycle/performance and all advertised-provider real sends (FBA-001/002/003/004). |
| 24 | Task-specific Android deliverable | Exact release-signed ARM64 candidate with core Supabase flows, local USE + installed SmolVLM2/Needle, consented cloud legs, phone/grounding/modes, App Links/push/reply and telemetry acceptance. `apps/mobile/android/`, `docs/runbooks/gate-e-device-run.md`, sharing/push runbook. Not an obsolete cloud-only debug-APK placeholder. | IN_PROGRESS | NOT_EXECUTED: final candidate build identity/signature/hash, fresh install + beta.2 upgrade, every Gate-E/core-flow/link/push/reply/telemetry row and post-publish smoke (FBA-002/017/019/020/026). BLOCKED pending authorized physical ARM64 device/operator and approved signed candidate. |

## Evidence boundaries and closure

- Audit baseline: CI 37348171843, Web 37348171827, mobile 3330/API 156 reported
  passes, AI gate 12/12 + 64/64. FBA-021 records a retry-dependent MapPickerSheet
  flake; native/model-smoke proof is from earlier relevant commits. These results
  are neither a fresh run of this documentation diff nor final-candidate proof.
- Original acceptance report frozen 2026-09-15 at `e813028` (with later edits and
  2026-09-16 non-device evidence) is archived unchanged as
  [historical report](history/FINAL_ACCEPTANCE_REPORT_2026-09-15_e813028_as-of-b472a24.md).
  Its Edge Function AI, GPU-only/no-CPU and old test counts are not current truth.
- Actual OpenRouter send proof is historical/reported for that provider only.
  Other BYOK adapters remain experimental until per-provider send proof; cloud
  pricing/consent gates do not certify delivery. Local specialized models require
  native proof and are not general offline chat capability.
- Requirement 5 is not complete because email works; 20 is not complete because
  CSV works; 23/24 are not complete because a host build or AI gate is green.
  Latest owner implementation directives take precedence over older scope waivers.
- Final acceptance needs dated evidence tied to exact SHA (and dirty diff if any),
  artifact hashes/signature, device/model identity and executed row results. Missing
  prerequisites remain blockers. No device/live/SMS/Crystal success was asserted
  by this documentation reconciliation.
