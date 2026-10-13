# Decisions and remaining prerequisites — FindBack

Reconciled 2026-10-13 (corrective wave after owner audit FB-AUD-01..08,
as-of audited main `fb66238`; ledger `completion-ledger.json` names the exact
reconciliation commit). The 2026-10-06 v8-beta reconciliation below is
historical provenance, not the active baseline.
Latest owner directives override historical pivot/deferment text. A working demo
adapter does **not** remove a completion or release blocker.

**Release: HOLD — no release authorized.** The annotated `v1.0.0` tag exists
(`bb62dde`, unmoved) and main is considerably beyond it with post-v1
functionality (comment attachments, keyless MapLibre pivot, canonical
reactions, assistant restructure). The 2026-10-06 "READY (v8 beta line)" below
is superseded. Runtime acceptance is deferred per
`Communication/DEFERRED_RUNTIME_ACCEPTANCE.md` (D01–D14); live migration truth
per owner audit: `20261012010000` + `20261012020000` applied on the hosted
project, `20261012030000` (avatar host-bind) + `20261013010000` (attachment
UPDATE bind) pending canonical apply. The ledger holds 38 items (36 + 2 split
entries); all are in closed statuses with the device/live-bound ones WAIVED or
BLOCKED_EXTERNAL, not proven.
Photo grounding, account-bound sends, assistant modes, phone verification and
password recovery are shipped, reviewed and CI-executed; device, live-provider
and licensed-tooling acceptance remain external. Nothing here is intentionally
deferred scope without a named owner and blocker in the ledger.

## Settled architecture (not deferred decisions)

- Android React/Capacitor talks directly to hosted Supabase Auth, PostgREST,
  `pg_graphql`, private Realtime Broadcast and Storage. The Node Express,
  GraphQL-Yoga and Socket.IO API is a Docker/coursework reference, not a mobile
  runtime dependency; SQLite is local/reference/test-only.
- Report-photo **automatic** analysis attempts SmolVLM2 locally first; only the
  consented cloud leg sends, with the key resolved for the requesting account
  (fail-closed on account switch or absent session). **On-device-only** fails
  closed without sending; **cloud-only** skips local. Consent copy is derived
  from the effective engine, never static local-first wording.
  `services/analyzeReportPhoto.ts` and `services/livePhotoGrounding.ts` are the
  transport authorities. Help has direct BYOK providers, built-in answers and
  installed specialized local models where wired; it must not be described as a
  general offline support chatbot.
- CPU is first-class and the Smol default. Measurement can select a vision
  backend for the session only with fresh correctness evidence; the language
  decoder is CPU on both measurement arms. GPU initialization failure announces
  an explicit CPU retry, not silent cloud escalation. Hardware discovery is not
  acceleration proof. No physical performance claim is accepted yet.
- Possible Matches defaults to local USE embeddings, top-3 cosine plus transparent
  bonuses, not probability. Installed Needle is an explicitly selected challenger,
  not an automatically promoted replacement. LFM/llama.cpp remain non-shipping labs.
- Model downloads are explicit and checksum-verified; startup rehashes installs
  but does not auto-download, load inference or benchmark. Web refuses native AI.
- Mobile builds must assert nonempty `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_PUBLISHABLE_KEY` derived from the canonical local env before
  building, reject secret/service-role keys, and prove the URL in bundled assets
  with `scripts/check-release-config.mjs` or equivalent before handover.

## Open decisions / prerequisites

| Item / audit IDs | Owner | Current truth / blocker | Required closure evidence |
|---|---|---|---|
| Photo grounding UI — FBA-001 | Main implementation owner | SHIPPED (code seam). Reviewed consumer with consent-gated selection, account-bound sends and per-engine consent. Remaining: exact-candidate device walkthrough. | Interaction/consent/invalid-box/no-result tests (shipped); reviewed selection preserves draft; exact-candidate device walkthrough. |
| Assistant/photo mode truth — FBA-003 | Main implementation owner | SHIPPED (code seam). Modes enforced end-to-end; engine account-scoped with no global slot. Remaining: device evidence. | Exposed modes, migrated/stale selection, unsupported model/task, no-cloud on-device-only, no-local cloud-only (shipped + tested), plus device evidence. |
| Phone verification — FBA-005 / requirement 5 | Main implementation owner + hosted Auth/SMS operator | SHIPPED (code seam). Send/resend/verify/cooldown + server sync + CI-executed SQL. Remaining: live SMS receipt. | Configure approved real SMS provider in hosted Supabase; test phone change/reverification, cooldown, invalid/expired code, throttling and isolation; live SMS receipt + verification on candidate. |
| Password recovery — FBA-035 | Main implementation owner + hosted Auth operator | SHIPPED (code seam). Forgot-password entry, reset email, verified `/recovery` deep link, new password; anti-enumeration throughout. Remaining: live email delivery (hosted redirect allowlisting + inbox). | Hosted redirect-URL allowlisting; real reset email receipt + link exchange + password update on candidate. |
| Account deletion — FBA-036 (explicit scope decision) | Owner + main implementation owner | IMPLEMENTED, hosted proof waived for v8 beta. Self-serve deletion shipped: `supabase/functions/delete-account` (JWT-uid-only purge: storage prefix, cascade users-row wipe, admin auth delete), `requestAccountDeletion()` client, typed-email confirm UI in AccountSettings with logout wipe; capability manifest + knowledge base declare it supported. Live-deletion proof against hosted backend is external — covered by the v8-beta owner waiver, tracked for a hosted run. | Hosted live-deletion proof run, or accept the waiver as final for the beta line. |
| BYOK provider promotion — FBA-004 | Provider verification owner | OpenRouter is the only provider marked live-tested in baseline UI. OpenAI, Anthropic, Google, DeepSeek, Mistral, Groq, xAI, Cohere and custom endpoint remain experimental/unproven; native provider requires Gate-E. Connection/catalogue/probe success is not real-send proof. | Authorized user-owned keys/endpoints and explicit paid-route consent if needed; redacted actual-send success/error evidence per provider/model/SHA, or owner-approved explicit lab-only visibility. No automatic promotion. |
| Physical ARM64 gate — FBA-002/014/026, requirements 12/23/24 | Authorized device operator | NOT_EXECUTED. Runbook prepared, not a passing run; no current device/ADB availability is inferred from an old report. | Authorized physical ARM64 phone, working ADB, exact signed candidate/hash/model pins, every Gate-E row and fresh-install/upgrade/core-flow artifacts. |
| Push / App Links / direct reply — FBA-017/019/020 | Infrastructure + device operator | Backend callable historically; zero-work dispatch is not delivery. | Real queued notification, registered physical device, release certificate/domain association, foreground/background/cold delivery/tap/link routes and shade reply with backend mutation/isolation proof. |
| Telemetry — FBA-015 | Release/security + device operator | Build boundaries automated in CI (synthetic-DSN bundle asserts, scrubbed-env preflight failure, stale-assets packaging refusal); release synthetic-event receipt and signed-device proof unresolved. | Approved telemetry project access, exact signed assets, synthetic event received with scrubbed payload; no stale Gradle assets or credential leakage. |
| Crystal Reports artifact — FBA-006 / requirement 20 | Licensed Windows designer operator + evaluator | EXTERNAL_BLOCKED: JSON/CSV/SQL exist, no genuine `.rpt`. Reporting guide's old "out of scope" language is not a current waiver. | Produce/open/render a genuine `.rpt` with licensed Crystal Reports tooling and permitted data access, attach artifact/hash/render evidence; alternatively obtain explicit evaluator acceptance of CSV/API substitute. Never fabricate or rename a file to `.rpt`. |
| Similarity acceptance baseline — FBA-013 | Matching owner + device evaluator | Source cutoff/weights are implemented but representative calibration is unverified. | Dataset/version, measured metrics/rankings, accepted cutoff/weights and regression fixtures; explicit baseline freeze must explain limits. |
| Motion-photo vendor support — FBA-016 | Media owner | SHIPPED. Deterministic generated fixture runs in CI; Xiaomi file kept as labeled MANUAL-ONLY optional suite. | Licensed/consented deterministic fixture or valid generated equivalent run in CI (done), or explicit supported-scope decision and copy update. |
| Final security / release — FBA-007/008/022/025/026/033 | Main/release owner | Root/mobile versions beta.2; no final candidate accepted. Exact-commit CI/Web/Docker/phone-SQL green on the closure-review wave. | Full-history secret/dependency/SAST + hosted RLS/grants/advisors, exact-SHA critical workflows, synchronized versions, signed multi-variant assets/checksums and post-publish install/upgrade. |
| Completion ledger / debt tracking — FBA-023/024 | Main implementation owner | SHIPPED. `completion-ledger.json` exists with 36 findings; `scripts/completion-gate.mjs` enforces integrity in CI, `--final` pre-release and `--release` (final + READY) in the release workflow. | Ledger keeps every finding with owner/state, evidence references and blockers; gate fails on missing mandatory evidence. Record real dispositions, not green-wave completion. |
| V8 beta waivers — FBA-002/006/013/014/015/017/018/019/020/026 (+ FBA-036 hosted proof) | Owner (signed 2026-10-06) | WAIVED FOR BETA. Ten device/live-bound items plus the hosted live-deletion proof ship unproven on the single-line v8 beta (0.8.0-beta.2 from main; beta.1 side-branch deleted by owner 2026-10-06). No device is attached; no live delivery was performed. Limitations stay user-visible; full closure needs the proof named in each ledger waiver. | Execute the named device/live proofs (Gate-E matrix, FCM delivery/tap/reply, App Links, telemetry, install/upgrade, Crystal .rpt or evaluator acceptance, similarity probe, hosted deletion) and retire each waiver with evidence. |

## Superseded decisions

The 2026-09-25 cloud-only pivot, local-VLM retirement, retired ARM64 VLM gate,
GPU-only/no-CPU policy and server `ai-help` mobile routing are **historical, not
current architecture**. Phone/grounding/mode work cannot be scoped away by that
old log. Debug package/signing assumptions do not establish a release certificate.
Historical evidence is preserved separately under `docs/history/`.
