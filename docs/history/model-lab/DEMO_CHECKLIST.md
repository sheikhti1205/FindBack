# FindBack — teacher demo and acceptance checklist

Updated 2026-10-06 (closure-review wave; exact reconciliation commit in
`completion-ledger.json` `generatedFor`). **Release: READY (v8 beta line).** This is a procedure,
not a checked-off device or live-provider run. Use the independent implementation/
verification statuses in [REQUIREMENTS_MATRIX](REQUIREMENTS_MATRIX.md) and all
36 findings in [COMPLETION_AUDIT](COMPLETION_AUDIT.md). Grounding, modes, phone
and recovery are shipped code seams awaiting external acceptance, not
intentionally deferred or accepted.

A 10–15 minute class demo is not enough for Gate-E, SMS, provider breadth, push,
telemetry or release acceptance. Record exact candidate SHA/diff, APK hash,
version/certificate, device/OS and model pins before claiming any result.

## 0 · Prepare (do not build blind)

1. Use a candidate with nonempty `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY` derived from canonical local env **before**
   any web/APK build. Only publishable keys; never service-role/secret keys.
   Require post-build `scripts/check-release-config.mjs` (or equivalent) URL/
   bundle/APK proof, share-origin/signing/config checks before handover/install.
2. Mobile connects directly to hosted Supabase. No Node/laptop API is required
   for app flows; Node/Docker is reference/reporting coursework only. A web demo
   cannot prove native inference, device permissions or signed App Links.
3. Use authorized test accounts/email inboxes and permitted photos. Register two
   actual hosted accounts for realtime/isolation; reference SQLite seeded logins
   are not production accounts. Do not expose credentials in captured evidence.
4. Native proof requires an authorized physical ARM64 phone + working ADB, pinned
   downloads and signed exact candidate. Get main-owner authorization for live
   sends, published test data, notifications and device mutations.
5. OpenRouter alone is marked live-tested in baseline UI. Other BYOK providers
   are experimental pending authorized actual sends; a connected key/catalogue
   does not prove send success. Prepare approved SMS/FCM/telemetry access and
   licensed Crystal tooling for the separate mandatory gates, not fake substitutes.

## 1 · Auth, username and verification (requirements 4, 5, 11)

- [ ] Register: username available/taken, case/underscore/race behavior; email,
  password and phone inputs; no private email/phone in public post payloads.
- [ ] Receive actual emailed Supabase OTP; verify/resend/error paths. Email proof
  is historically reported, not a fresh candidate result.
- [ ] Phone: code seam shipped (send/resend/verify/cooldown + server sync + CI-executed SQL). With hosted
  real SMS configured, receive actual SMS, resend with cooldown, verify, reject
  invalid/expired/rate-limited codes, change number/reverify, prove isolation.
  Until then show truthful unverified state; do not count #5 complete.
- [ ] Password recovery: request reset email (same message whether or not the
  address exists), follow the `/recovery` link, exchange code, set a new
  password, land signed in. Live email needs hosted redirect allowlisting.
- [ ] Login/session restore/refresh/logout/relogin. Remembered AI-key removal
  confirmation appears only when stored keys exist; purge failure cannot trap
  logout; sibling account's credentials remain isolated.

## 2 · Create, review and publish (requirements 6, 9, 10, 13–16, 23)

- [ ] Report tab: Lost/Found, title/description, category dropdown, calendar date
  (invalid/future refusal), rich text and draft recovery/validation.
- [ ] Attach permitted photo(s) via picker/camera; preview/order/remove, permission
  denial/normalization/error handling. Photos upload to owner Storage only on
  publish; capture final image and isolation evidence.
- [ ] Location: optional one-time fix, denied/services-off/coarse recovery, manual
  label/coordinates/Maps link, approximate/exact selection and map preview/pin.
- [ ] **Analyze photo**: explicit consent and review-only suggestions. Automatic
  attempts installed SmolVLM2 first, then consented OpenRouter fallback if absent/
  failed; on-device-only never sends, cloud-only skips local. No silent paid route.
  Review Apply/Keep; replacement confirmation protects typed fields. No auto-apply.
- [ ] **Photo grounding**: execute only once main returns integrated UI/tests.
  Select photo/describe target, review valid selectable regions, no-match/invalid
  result, cancel/stale response, selection/draft preservation and consent. Baseline
  service unit tests alone do not satisfy this in-progress UI acceptance.
- [ ] Valid YouTube link renders/plays; invalid link rejected. Show animated card
  entrance, Tailwind light/dark/AMOLED/accent and reduced-motion/large-text behavior.
- [ ] Publish → post detail; source/device/backend evidence for each failure path.

## 3 · Matching, AI models and modes (requirements 12, 23)

- [ ] Open an OPEN report: Possible Matches shows up to three OPEN opposite-type
  reports, native USE embeddings + cosine/transparent bonuses, never probability.
  Candidate retrieval needs available backend data; local scoring is not full
  offline data access. Capture actual native rankings and dataset/metrics.
- [ ] Settings → AI & models → On-device AI (`/settings/ai/models`): explicit
  Needle/Smol downloads, progress/Pause/Resume/checksum/install/remove/corruption/
  kill-relaunch. Startup must not auto-download/load/benchmark.
- [ ] CPU is first-class/default; CPU/GPU measurement correctness/real counters,
  GPU unavailable/error and explicit CPU retry. Decoder stays CPU on both arms;
  hardware discovery is not proof of acceleration or performance. There is no
  in-app measurement button since 2026-10-25 (owner: no CPU/GPU vocabulary on
  consumer surfaces) — run it through `service.measure('cpu'|'gpu')`.
- [ ] Explicit installed Needle challenger selection for session only; fixed
  candidate comparison to USE, remove/restart defaults, no automatic promotion.
- [ ] Help uses chosen direct BYOK model or installed specialized model where
  wired; built-in fallback is not live AI. Needle structured extraction and Smol
  approved-image description are not a general offline support chatbot.
- [ ] Modes shipped: check UI/persistence/migration,
  on-device-only no-cloud, cloud-only no-local, unsupported model/task and stale
  web offline refusal. Do not demo hidden/unhonored legacy modes as complete.
- [ ] Per promoted BYOK provider capture real send/error/consent evidence with
  approved keys. Leave unproven adapters explicitly experimental/lab-only.
- [ ] Run **every** row in [Gate-E](runbooks/gate-e-device-run.md), including
  lifecycle/cancel, memory/thermal/battery, accessibility and web refusal. Host
  tests are wiring proof, not substituted device results.

## 4 · Engagement, pagination, search and recovery (requirements 2, 3, 7, 8)

- [ ] Two hosted accounts: comment/nested reply → second client live update;
  like/dislike/remove count; rating upsert/live average; no cross-account writes.
- [ ] Feed/search Lost/Found/category/status/query/nearby filters, infinite scroll,
  page order/deduplication, refresh/reconnect. Use only authorized test reports.
- [ ] Owner My Reports/status OPEN → MATCHED → RECOVERED; ownership guard.
- [ ] Inbox read/unread/undo, restore after process death/relaunch, reply routing
  and stale-state recovery. Link/push device proof is a separate mandatory step.

## 5 · Sharing, push and release telemetry (final acceptance)

- [ ] Exact release-signed device: verified domain association and App Links from
  browser/messages cold/warm/background, sign-in resume and report/reply focus.
- [ ] Real pending notification: backend attempt/sent proof and actual registered
  physical device receipt, foreground/background/cold tap routing; token refresh/
  pruning on reinstall/logout/account switch and two-account authorization.
- [ ] Receive reply-capable notification; shade direct reply → backend comment →
  in-app thread/inbox update; expiry/replay/isolation checks. Zero-work dispatcher
  success and validate-only FCM cannot tick these boxes.
- [ ] Exact release synthetic telemetry event received/scrubbed, asset freshness,
  no secret/BYOK leakage; approved telemetry project/operator required.
See [sharing/push runbook](runbooks/SHARING_AND_PUSH_INFRASTRUCTURE.md).

## 6 · Reporting, ERD and modern APIs (requirements 1, 18–20, 22)

- [ ] Open `docs/erd/ERD.pdf`, zoom/vector quality and compare to final schema.
- [ ] Supabase PostgREST username/feed RPC and `pg_graphql` role-filtered queries;
  final RLS/grants/advisors/privacy/isolation. `docs/API_DEMO.md` live counts are
  historical; its server `ai-help` section is reference, not mobile AI routing.
- [ ] Show Node reference `/reports/activity`, SQL/JSON/CSV in
  `docs/reporting/REPORTING.md`; Docker build/run/health evidence on final SHA.
  Reporting data access is server/operator-only, never bundled secret access.
- [ ] **Crystal:** licensed Windows designer creates, opens and renders genuine
  `.rpt` with artifact/hash/output evidence, or attach explicit evaluator-approved
  substitute. API/CSV demo alone does not complete #20; never fabricate `.rpt`.

## 7 · Deliverable and final gate (requirements 17, 21, 24)

- [ ] Show Git/Vite/React workflow and final-SHA clean lint/typecheck/tests/AI gate,
  native/model/web/CI/security results, with no rerun-dependent flake acceptance.
- [ ] Assert public build env; prove final URL/config, synchronized versionCode/
  versionName/certificate/hash, fresh release install **and beta.2 upgrade** on
  physical ARM64. Debug APK/emulator/class demo is not final signed acceptance.
- [ ] `completion-ledger.json` reconciled with reviewed evidence
  for all findings (gate binds it to HEAD). Record blockers instead of ticking unexecuted rows.
- [ ] With owner approval only after closure: immutable next tag, ABI/universal
  APKs + AAB + manifest/checksums; download/hash/signature verify and post-publish
  fresh-install/upgrade; replace current READY statement with exact released-SHA report.

## Requirement → demo map

| # | Section | # | Section |
|---|---|---|---|
| 1 | §6 | 13 | §2 |
| 2 | §4 | 14 | §2 |
| 3 | §4 | 15 | §2 |
| 4 | §1 | 16 | §2 |
| 5 | §1 | 17 | §7 |
| 6 | §2 | 18 | §6 |
| 7 | §4 | 19 | §6 |
| 8 | §4 | 20 | §6 |
| 9 | §2 | 21 | §7 |
| 10 | §2 | 22 | §6 |
| 11 | §1 | 23 | §2–3 |
| 12 | §3 | 24 | §5/7 + all Gate-E |

All boxes start **NOT_EXECUTED** for the eventual candidate. Retain PASS/FAIL/
BLOCKED, exact steps, artifacts and failure notes. Missing SMS/tool/provider/
device/signing/hosted access remains a blocker, never a simulated success.
