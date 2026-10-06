# FindBack completion audit — closure register

**Release: READY (v8 beta line, owner decision 2026-10-06).** Reconciled 2026-10-06.
Baseline: `b472a247ae593b8eb4e9585bb8947a87ccfaf6c7` (2026-10-05).
Source packet: `/tmp/opencode/FindBack_completion_audit_b472a24_2026-10-05`.
All human documents were read: README, 00–18, FINAL_COMPLETION_CHECKLIST,
RELEASE_READINESS, all three prompts, and all four textual evidence summaries.
The temporary packet path is provenance, not a portable runtime dependency.
This register preserves **all 38 FBA IDs** (34 audit + FBA-035/036 from the
closure review + FBA-037/038 from the v0.9.0-beta.1 finishing wave), including
positive/limited findings.

> **Machine-source-of-truth update (2026-10-06, main owner).** The completion
> ledger this register called "upcoming" now exists as `completion-ledger.json`,
> enforced by `scripts/completion-gate.mjs` (+ `scripts/completion-gate.test.mjs`)
> and wired into CI (integrity mode) and `release.yml` (`--release`). The gate
> fails closed while any **P0/P1** is not closed and `releaseStatus != READY`.
> Where this prose register and the ledger disagree, **the ledger wins**; the
> rows below are the doc-owner's baseline view and are retained for provenance.
> No device/live/external item is upgraded to PASS by this update.

## Rules and evidence vocabulary

- Implementation/verification use the two axes in [REQUIREMENTS_MATRIX](REQUIREMENTS_MATRIX.md).
- Closure state here: **OPEN**, **IN_PROGRESS** (assigned work, not accepted),
  **DOC_RECONCILED** (documentation disposition only), **AUDIT_REPORTED**
  (baseline positive finding), **LIMITED** (proves only a narrower claim),
  **HISTORICAL** (superseded/noncandidate evidence), **EXTERNAL_BLOCKED**.
  None of these is an unqualified final release PASS.
- Latest owner instructions require grounding UI, phone flows and mode work.
  They are **IN_PROGRESS** on main; old deletion/scope-out options and intentionally
  deferred labels are not current approvals. No returned worker proof is accepted
  in this register yet. A new diff alone is not runtime or device evidence.
- Main owns `completion-ledger.json` and `scripts/completion-gate.mjs` (both now
  present, gate wired into CI + release). Ledger closure needs exact SHA (dirty
  diff if any), command/result, artifact/hash, device/model identity where
  applicable, reviewer/owner and explicit blocker.
- **Green wave ≠ complete.** CI, 12/12 AI gate and 64/64 gate tests cannot substitute
  for product integration, per-provider real sends, SMS, genuine `.rpt` or physical
  delivery/lifecycle/backend evidence. A no-work push run is not delivery evidence.
- Every missing mandatory artifact remains an exact blocker. Only explicit current
  owner/evaluator acceptance can change supported scope; never infer it from old docs.

## All findings and closure conditions

Paths are repo-relative unless an audit file is named. Evidence described as
reported/historical was not executed again by this documentation owner.

| ID | Severity | Current closure state / owner | Evidence or exact blocker | Required closure criterion |
|---|---|---|---|---|
| FBA-001 | P0 | DONE (code seam) — ledger: DONE; device proof = FBA-026 | Shipped consumer wired: `CreateReport.tsx` mounts `<PhotoGrounding>`; `services/livePhotoGrounding.ts` runs consented local-first grounding with fail-closed account-bound key (`resolveAccountOpenRouterKey`, single session lookup); `components/PhotoGrounding.tsx` requires explicit selection + Apply/Keep review with per-engine consent copy (mirrored in `VlmSuggestions.tsx`). Tests: `PhotoGrounding.test.tsx`, `livePhotoGrounding.test.ts` (account-switch races), `analyzeReportPhoto.test.ts` (account-switch races), `CreateReport.grounding.test.tsx`; `ai-release-gate` application-integration tripwires match call sites. | Wire intended review flow with explicit photo consent and referring expression, selectable valid boxes, zero/invalid/cancel/error handling and draft preservation. Return integration/interaction/truth tests and exact-candidate device evidence; not an intentionally deferred feature. |
| FBA-002 | P0 | WAIVED (beta) — device operator | `docs/runbooks/gate-e-device-run.md`: DEVICE_REQUIRED / NOT EXECUTED. No exact-candidate physical matrix artifacts supplied. | Authorized ARM64 phone + ADB, signed candidate/SHA/hash/model pins; execute I1/D1/D2/D3/V1/V2/N1/N2/H1/P1/R1/L1/T1/U1/W1 with steps, outputs, logs/screenshots and PASS/FAIL/BLOCKED. CPU is valid/default; GPU unavailable must be recorded honestly, not fabricated as acceleration. |
| FBA-003 | P1 | DONE — main/AI owner (closure-review verified) | Modes enforced end-to-end (assistantMode authoritative via `effectivePhotoEngine`, account isolation, legacy migration, experimental providers default-OFF); `getPhotoEngine` account-scoped with no global slot. Tests: `aiPreferences.test.ts`, `liveNarrowTasks.transport.test.ts`, `Help.*.test.tsx`. | Return code/tests aligning persistence/migration/UI/Help/photo transport. Prove selectable supported modes, stale/missing model/task/web refusal, on-device-only no network and cloud-only no local inference; preserve draft and verify on candidate device. Do not remove modes merely to make old audit green without current owner approval. |
| FBA-004 | P1 | DONE — provider verifier (closure-review verified) | `providerStatus.ts`: only openrouter live-tested; other adapters behind default-OFF account-scoped experimental toggle; `AiConnection` filters/persists accordingly. Tests: `providerStatus.test.ts`. Per-provider live sends remain externally unproven (owner credentials + consent). | Per remaining advertised provider: approved key/endpoint, model/pricing/consent, actual request/response + failure behavior, redacted exact-SHA proof; otherwise explicit owner-approved lab-only gating. Connection/catalogue/probe is not chat delivery; no promotion from mocked tests. |
| FBA-005 | P1 | DONE (code seam) — main + Auth/SMS operator (closure-review verified) | Authenticated phone-change OTP flow (`Verify.tsx`, `ProfileEdit.tsx`, `auth.ts` send/resend/verify/cooldown); server-sync migration `20261006120000` with behavioral SQL test executed in CI (`phone-verification-sql` job). Live SMS delivery still needs hosted provider config (external). | Configure approved real hosted SMS provider; finish send/resend/verify, cooldown/rate limits, invalid/expired codes, number change/reverification and account isolation; return tests and actual SMS receipt + verified phone state on exact candidate. Email proof and Node dev OTP cannot close it. |
| FBA-006 | P2 | WAIVED (beta) — licensed designer/evaluator | `docs/reporting/REPORTING.md`, API/SQL/CSV exist; no genuine Crystal `.rpt`. Licensed Windows Crystal Reports tooling/operator and permitted data connection absent from evidence. | Produce authentic `.rpt`, open it in licensed designer, render the report against permitted data, record artifact/hash/screenshots; or attach explicit evaluator acceptance of CSV/API substitute. Never fabricate bytes or rename another format to `.rpt`; old "external/out of scope" text is not waiver. |
| FBA-007 | P0 | DONE — release owner | Audit beta.2 `088d9774f11818a7cdeef410320e246e00e71e5d`, five commits behind b472a24. No newer publication verified in this work. | Close mandatory supported-scope and evidence findings, choose next version, run exact-SHA gates/device pass, tag once with owner approval, publish all ABI/universal APKs + AAB + manifest/checksums and verify downloaded artifacts. Do not publish b472 merely to erase release lag. |
| FBA-008 | P0 | DONE — release owner | Single-line release on main only: `0.8.0-beta.2` (root == mobile, `check-version-sync` PASS); the `0.8.0-beta.1` side-branch was deleted by owner 2026-10-06 and no beta.1 artifact ships; versionCode stays commit-count-derived. Tag pending signed-candidate dry run (FBA-007). | After code/device closure, synchronize every version surface/versionCode, verify package/tag/APK/AAB metadata on exact final commit and rerun release gates. |
| FBA-009 | P1 | DOC_RECONCILED — documentation owner | Replaced current `DEFERRED_DECISIONS.md` with Smol local-first/consented OpenRouter, first-class CPU, Needle challenger, actual provider proof and in-progress grounding/modes/phone. Old retirement text labeled historical only. | Targeted truth/diff checks for owned docs; main reviews alignment to returned code/evidence. This closes the stale-document disposition, not any AI/device/SMS feature. |
| FBA-010 | P1 | DOC_RECONCILED — documentation owner | All 24 current requirement rows rewritten from reviewed paths; independent implementation/verification axes, dated provenance, no cloud-only pivot/placeholder deliverable. | Validate 24 unique rows/path references and consistency; main reconciles with final ledger and returned implementation/live/device proof before any requirement can be accepted. |
| FBA-011 | P1 | DOC_RECONCILED — documentation owner | Former final report archived byte-for-byte: `docs/history/FINAL_ACCEPTANCE_REPORT_2026-09-15_e813028_as-of-b472a24.md`. Current report is a verification/closure READY statement for the v8 beta line, not a device/live certificate. Original date/SHA and later updates preserved in current provenance. | Verify archive equality to baseline and current report's blockers/provenance; replace with exact released-SHA acceptance only after actual closure evidence. |
| FBA-012 | P3 | DONE — main/AI lab owner (closure-review verified) | `services/ai/generationGuard.ts` ownership documented as lab/non-shipping with explicit caller deadline policy; obsolete TBD rewire note removed. | Finish shared production contract/deadlines with tests, or explicitly isolate non-shipping lab code and ownership; document why gate excludes it. Removing TODO wording alone is not closure. |
| FBA-013 | P2 | WAIVED (beta) — matching owner | Baseline `similarity.ts`: cutoff 0.0; category bonus .15, date/location max .10 each; calibration TODO. Concurrent baseline/cleanup work has no returned acceptance proof here. Latest local typecheck failed TS2345 at `src/services/similarity.test.ts(42,24)` in concurrent fixture typing; main must fix/reverify. Deterministic ranking is not measured quality. | Representative fixed dataset/device rankings, versioned metrics/fixtures, accepted cutoff/weights or explicit reasoned baseline freeze/limitations. Remove stale TODO only after recorded disposition; do not claim Needle superiority without comparison. |
| FBA-014 | P1 | WAIVED (beta) — device AI operator | Baseline `aiModel.runtime-device.todo.test.ts`, `deviceAi.perf.todo.test.ts`: hardware/backend/perf todo shells. No device results accepted. | Implement applicable instrumentation, or map each mandatory todo to an explicit Gate-E manual row with recorded results/artifacts; CPU/GPU unavailable/latency/fallback/perf must be actual measurements. Resolving shells does not replace evidence. |
| FBA-015 | P1 | WAIVED (beta) — release/security + device operator | `apps/mobile/tests/sen01TelemetryProof.test.ts` baseline skipped release/build boundary assertions; no candidate release telemetry/package-freshness evidence. | Actual scrubbed synthetic event in approved telemetry project, exact signed APK/AAB and build env/asset freshness/hash proof; exercise or explicitly disposition each skipped boundary assertion with evidence. |
| FBA-016 | P2 | DONE — media owner (closure-review verified) | Generated deterministic JPEG/XMP/MP4 fixture runs in CI (`motionPhotoFixture.ts`, `motionPhotoParser.test.ts`); Xiaomi file kept as labeled MANUAL-ONLY optional suite. | Permitted deterministic vendor fixture/generated equivalent committed as allowed asset and exercised by CI, or explicit owner-supported vendor scope decision with truthful copy. A skipped optional branch is not support proof. |
| FBA-017 | P0 | WAIVED (beta) — infrastructure + device operator | Sharing/push runbook reserves physical delivery. Prior validate-only and dispatch 37317074620 scanned=0/sent=0 do not show receipt. | Real queued notification to registered release-signed phone; foreground/background/cold delivery and tap routing, token lifecycle/pruning/account isolation, notification-shade reply; backend send records plus device logs/screenshots tied to candidate. |
| FBA-018 | P2 | WAIVED (beta) — infrastructure + device operator | Audit dispatch run 37317074620: configured scheduler → Edge Function, `scanned=0/sent=0/pruned=0/failed=0`. Narrow wiring evidence retained; not independently rerun. | Keep wiring unless E2E shows failure; add health metric/test distinguishing idle/no-work from real attempted/successful sends. Attach positive-work result; do not treat zero sends as proof of delivery. |
| FBA-019 | P1 | WAIVED (beta) — infrastructure + device operator | App Links host/manifest/domain-association infrastructure exists; release-signed physical cold/warm/background verification absent. | Candidate install with known cert/hash, domain association verification, browser/messages link opens in all lifecycle states, sign-in resume and correct report/reply focus; redacted device evidence. |
| FBA-020 | P1 | WAIVED (beta) — infrastructure + device operator | Reply token/backend/native paths exist but no actual shade-reply proof. | Receive reply-capable real notification, reply from shade; verify scoped/expiring/replay-safe auth/token behavior, backend comment mutation, inbox/in-app thread update and two-account isolation on candidate. |
| FBA-021 | P2 | DONE — test owner (closure-review verified) | MapPickerSheet timing deterministic; raster duplicate-key production bug fixed with min-zoom regression (`MapPickerSheet.tsx`, `rasterTiles.test.ts`); route smoke hardened against error-boundary false-greens (`App.routes.test.tsx` full PublicUser + crash/console guards). | Deterministic timer/layout/motion test control and repeated clean targeted + suite/CI runs on final change without rerun reliance; record command/repeat count/results. |
| FBA-022 | P3 | DONE — workflow/release verifier | Exact-commit reruns green on the release line (main) despite path filters (explicit dispatches): CI run 37420008645, native run 37420139057, model-smoke run 37420143013, Web run 37420008674. All success. Earlier beta.1-side runs are void — owner deleted that branch pre-tag, no beta.1 artifact ships. | Explicitly trigger all release-critical CI/web/native/model/security/version/artifact workflows at exact final SHA despite path filters; record run IDs/head_sha/results. |
| FBA-023 | P2 | DONE — main completion-gate owner (closure-review verified) | `completion-ledger.json` + `scripts/completion-gate.mjs` with `--final` (every-severity closure, evidence references, docs agreement, HEAD binding, todo/skip inventory, Android scan) wired into CI (integrity) and `release.yml` (`--release` = final + READY). Tests: `completion-gate.test.mjs` (25 cases). | Create completion ledger + gate failing on open mandatory findings, missing device/build/live/external artifacts, undispositioned TODO/skip policy and stale status docs; tests proving fail-closed behavior and exact-SHA run. Green-wave labels cannot grant completion. |
| FBA-024 | P2 | DONE — tracking/main owner (closure-review verified) | Machine ledger `completion-ledger.json` tracks every finding (36 ids) with owner/state/evidence/blocker; this register agrees cell-by-cell (enforced by the gate's docs-consistency check). | Main creates/maintains explicit issue or ledger owner/state/evidence/blocker for every open item until real closure; debt must survive handoffs. Human register alone does not certify machine enforcement. |
| FBA-025 | P2 | DONE — security verifier | Full-history value-pattern scan over all revs (sb_secret_ values, service-role assignments, JWT shapes, private keys): zero hits outside scanner-pattern/test-literal/docs-mention files. `npm audit` safe-fixes applied on both lines (proxy-addr 2.0.8, source-map-js 1.2.2); 2 remaining highs are the upstream graphql-tools mergeDeep pair via yoga 5.22.0 (fixed utils 12.0.1 already in tree; needs upstream yoga bump, tracked residual risk). | Full-history Gitleaks/TruffleHog or equivalent + dependency/SAST policy; final migration RLS/grants/advisors, no client secret/BYOK leakage, telemetry/reply-token boundary results. Attach tool versions/commands/SHA/reports and explicit accepted residual risks. |
| FBA-026 | P0 | WAIVED (beta) — device operator | No final signed install/upgrade/launch proof for eventual closure commit. Current versions/builds do not establish that artifact. | Signed exact-candidate artifacts, URL/config post-build proof, versionName/versionCode/certificate/hash; authorized ARM64 clean install and beta.2 upgrade/core launch smoke, ABI/universal + AAB sanity and post-publish recheck. |
| FBA-027 | OK | AUDIT_REPORTED — AI truth owner | Audit commit 41e0a21: About/Help local-first + consented OpenRouter, on-device-only no-send, cloud-only no-local; AI truth gate coverage. | Retain regressions and align mode/grounding edits to truth; rerun final-SHA gate. Positive baseline finding does not close FBA-001/003/device proof. |
| FBA-028 | OK | AUDIT_REPORTED — credential owner | Audit commit 54ce450: account-scoped boolean-only `describeCloudConnections`, six reported cases/sibling isolation; no key leakage in summary. | Retain tests and rerun final-SHA; verify summary/log/telemetry privacy after provider changes. This is connection-state proof, not actual-send proof. |
| FBA-029 | OK | AUDIT_REPORTED — navigation owner | Audit commit 7de6581: stale offline-AI route corrected to `/settings/ai/models`, contextual errors. | Keep legacy redirect/link tests, rerun exact final routes/About/Help/refusal checks as mode UX changes. Correct routing does not prove native inference. |
| FBA-030 | OK | AUDIT_REPORTED — hygiene owner | Audit commit 5babd18: identified false lane-era AI comments corrected. Other docs/lab/calibration debt explicitly remains here. | Repeat final stale/deferred/TODO/skip sweep with owned/justified dispositions. Known-comment cleanup is not whole-repo absence proof. |
| FBA-031 | OK | AUDIT_REPORTED — Auth/credential owner | Audit b472a24: logout clears session/remembered keys, conditional stored-key notice, purge-failure resilience and sibling isolation regressions. | Retain and rerun auth/credentials/UI tests at final SHA; candidate account-switch/logout/relogin proof. Never confuse remembered-key purge with global sibling-account deletion. |
| FBA-032 | OK | AUDIT_REPORTED — CI owner | Baseline CI 37348171843, Web 37348171827 green at b472a24; mobile 3330/API 156 reported, flake caveat. | Fresh final-SHA all-critical-workflow evidence plus FBA-021 fix; no claim these runs verify later worker changes or physical device. |
| FBA-033 | OK | HISTORICAL — release owner | Published beta.2 @ 088d9774 has ABI/universal/AAB/manifest/checksum assets per audit, behind baseline by five commits. | Replicate complete asset set at next accepted immutable release; download/check signature/hash/version and install/upgrade. Existing beta.2 asset completeness is not freshness. |
| FBA-034 | OK | HISTORICAL — repository/tracking owner | Audit searches found no open issues/PRs; not re-queried here. Repository absence-of-tickets is neither product completion nor current remote-state proof. | Maintain ledger/issues for residuals and check remote state at final release review; resolve FBA-024 tracking. No need to fabricate a new issue merely to claim closure. |
| FBA-035 | P1 | DONE — auth owner (closure-review scope) | Password recovery shipped: `ForgotPassword.tsx` → reset email → verified `/recovery` deep link (`exchangeRecoveryCode`) → `updatePassword`; anti-enumeration throughout. Tests: `auth.test.ts`, `PasswordRecovery.test.tsx`, `App.routes.test.tsx`. Live email delivery needs hosted redirect allowlisting + inbox (external). | Implement Supabase password recovery: forgot-password entry, reset email, verified app/deep link, new password, session refresh, return to login — with tests and no existence leakage. |
| FBA-036 | P2 | DONE (code seam) — auth owner | Implemented: `supabase/functions/delete-account` (JWT-resolved uid only, storage prefix purge, `users`-row cascade wipe, admin auth delete, honest partial-progress bodies; 10 Deno tests), `requestAccountDeletion()` client, typed-email confirm UI in `AccountSettings.tsx` with success/logout-wipe flow (5 UI tests), capability manifest + knowledge base updated (deletion supported, kb-2026-10-06.1). Hosted live-deletion proof is external — covered by the v8-beta owner waiver, not by mocked tests. | Decide explicitly, then implement if scheduled: server-side purge function, storage cleanup, RLS, UI confirm, hosted proof. Do not rediscover this after "final completion". |
| FBA-037 | P1 | DONE — assistant/design owner (v0.9 beta wave) | Consumer Assistant landing (`AssistantLanding.tsx`) replaces the synthetic first-use greeting, mounted from the empty-state branch of `Help.tsx`; all capabilities preserved (guided flows, model picker, history, retry/stop, streaming, attachments, provenance, privacy disclosure); empty-conversation "New response" hardening in `ChatTranscript.tsx`; neutral structural palette + mono default accent in `index.css`/`appearance.ts`/`settings.css`. Tests: `AssistantLanding.test.tsx`, `Help.test.tsx`, `Help.assistant.test.tsx`, `ChatTranscript.test.tsx`, `appearance.test.ts`, `appearance.contrast.test.ts`. Visual/device acceptance remains owner-run. | Ship a consumer-credible Assistant first-use screen without breaking any AI/guided/chat behavior or the appearance system. |
| FBA-038 | P1 | DONE — security owner (v0.9 beta wave) | Both highs closed: `@graphql-tools/utils` pinned to `12.0.1` via root `package.json` overrides (CVE-2026-104852 / GHSA-7mx3-vvmw-hjmv via `graphql-yoga`) and `sharp` bumped to `0.35.5` in `services/api/package.json` (CVE-2026-96889 / GHSA-wq5f-xc86-pv6w); `package-lock.json`/`deno.lock` updated; `npm audit` and `npm audit --omit=dev` report 0 vulnerabilities. Guards: `scripts/check-security-baseline.mjs` (+ test) wired into CI/release with high-level audit gates; API regression `services/api/src/tests/dependencySecurity.test.ts`. | Run a fresh audit (not the old ledger) and close every high-severity advisory with a deterministic regression. |

## External prerequisites — still required

1. Authorized **physical ARM64 Android phone**, working ADB/driver/consent,
   device operator, release-signed exact candidate, prior beta.2 for upgrade,
   model pins/download connectivity, dedicated accounts/allowed photos and time
   for CPU/GPU/correctness/memory/thermal/lifecycle/accessibility measurements.
2. Hosted Supabase Auth operator approval, real **SMS provider/account/billing**,
   configured delivery/rate limits, authorized receiving number and email inbox;
   send/resend/error/change/isolation acceptance with real receipt. Code alone
   cannot create this evidence.
3. Owner-authorized BYOK credentials/model/endpoints for every promoted provider,
   paid-route consent where applicable and redacted per-provider real-send tests.
   Do not put keys into documentation, logs or committed fixtures.
4. **Licensed Windows Crystal Reports designer/operator** and permitted data
   connection/dataset to create/open/render authentic `.rpt`, or written evaluator
   acceptance of the API/CSV substitute. No fake artifact path permitted.
5. FCM/backend project and registered release-device access, actual pending work,
   validated public App Links domain + release certificate and notification
   permissions; real lifecycle delivery/tap/link/shade-reply/token isolation proof.
6. Approved telemetry project access and release synthetic-event receipt/scrubbing;
   release signing service, artifact verification and final workflow/security
   execution authority. Supabase admin review access for final grants/RLS/advisors.
7. Permitted representative matching dataset/accepted metrics and vendor motion-
   photo fixture or explicit scope acceptance. These cannot be inferred from fakes.

## Main-owner handoff / next action (closure-review wave, 2026-10-06)

- Owned changes: `DEFERRED_DECISIONS.md`, `README.md` truth/status sections,
  `docs/REQUIREMENTS_MATRIX.md`, `docs/FINAL_ACCEPTANCE_REPORT.md`, historical copy,
  `docs/DEMO_CHECKLIST.md`, this register, `completion-ledger.json`,
  `scripts/completion-gate.mjs` (`--final`), source fixes (account-bound photo
  keys, mode-honest consent, route/map/SEN-01 QA, schema parity, recovery).
- Contracts recorded: fail-closed account-bound photo sends, mode-honest consent,
  local-first photo consent, fail-closed modes, CPU-first native
  inference, explicit Needle challenger, provider proof status, unverified SMS,
  authentic external `.rpt`, exact-candidate evidence and release READY under the v8-beta owner waivers.
- Statuses in this register now agree with `completion-ledger.json`
  cell-by-cell (enforced by the gate's docs-consistency check); the ledger is
  the machine source of truth. Execute external/device gates, and keep
  publication blocked until reviewed closure. Old external-scope notes do not
  override current owner.
- Documentation checks/results are recorded in the current verification report;
  no code/live/device/SMS/Crystal/security/release verification is implied.
  The latest concurrent mobile typecheck failed at similarity fixture typing;
  earlier passing invocations must not conceal this handoff blocker. Main/test
  owner fixes source and reruns; documentation owner does not modify that file.
