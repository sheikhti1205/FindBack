# 2026-10-14 host AI, auth, and shared-motion verification

**Acceptance: host wave PASS; release HOLD.** This records the working tree
based on committed main `0d2a293`, not an immutable final-candidate SHA.
The changes and this record are uncommitted at verification time. The machine
ledger still names `18280c8f5d74150dc63628cd4cdbd87bbcb44edb`; its reconciliation
has not been advanced to this source.

## Implemented and reviewed boundaries

- Qwen serves qualified prose; Needle serves structured tools. Eligibility
  requires the actual producer's installed, verified model. Neither producer
  borrows the other's roles or readiness. Unqualified Needle prose fallback
  is removed.
- Descriptor release validation parses metadata without executing it, checks
  each descriptor independently, and rejects computed/spread metadata,
  mutable aliases, missing pins, incompatible formats, and restricted download
  licenses. Qwen wiring approval is not measured device promotion.
- Advanced catalogue reasons wrap below a short status pill. Shared state/list
  transitions avoid doubled flow height and preserve outgoing scroll position.
- SDK account replacement synchronously clears prior-account private state
  and cancels its real local AI flight, before loading the replacement profile.
  Same-account refresh preserves state. Local sign-out also blocks repeated
  same-session `SIGNED_IN` reconfirmations, which can occur on tab refocus.
- Profile and completion-seed publication validate the SDK owner; delayed
  profile, login, registration, boot, and seed results cannot resurrect or
  overwrite a superseding account. Awaited SDK token snapshots cannot replace
  an intervening event's cache, including null → B → null changes.
- Rapid account resets share native settlement/unload cleanup. Cleanup retires
  its shared operation before reopening the gate, including resets queued by
  completion notifications. Verified model downloads survive account cleanup.
- `BACKEND_SCHEMA_VERSION=20261014010000` describes expected build schema;
  it does not assert the deletion fence is applied to hosted Supabase.
- Upload-token hygiene distinguishes actual syntactic credentials/client
  selectors from diagnostic strings, comparisons, and dynamic server values.
  Regressions retain quoted/multiline configuration, destructuring, class and
  enum defaults, imports, indexed types, and transparent TypeScript wrappers.
  The repository assertion reads tracked working-tree files, including legacy
  `.env` extensions and Vite mode-specific env files, without printing values.

## Executed verification

| Command / inspection | Result | Scope |
|---|---|---|
| `npm run test -w apps/mobile` | 419 files passed; 4,841 tests passed; 1 file/test skipped; 3 todo; 90.89 seconds | Complete mobile host suite, including 21 new auth/account-reset integration cases. |
| `npm run typecheck -w apps/mobile` | Exit 0 | Mobile TypeScript. |
| `npm run lint` | Exit 0 | Root `eslint .`. |
| `git diff --check` | Exit 0 | Working tracked diff whitespace. |
| `node scripts/completion-gate.mjs --final` | FAIL | Dirty working tree and stale ledger/source binding; final acceptance is not closed. |
| `/home/sheikh/android-sdk/platform-tools/adb devices -l` | No attached devices | Physical acceptance cannot run on this host at this checkpoint. |
| Initial `node --test scripts/ai-release-gate.test.mjs supabase/tests/migration_parity.test.mjs scripts/check-sentry-config.test.mjs` | 148/149 passed before the hygiene correction | AI gate 90/90; static migration parity 44/44; initial Sentry failure reproduced and subsequently fixed. |
| `node --test scripts/*.test.mjs supabase/tests/migration_parity.test.mjs` | 472/473 passed | Remaining failure is the real-repository READY fixture's exact-head binding, rejected because the tree is dirty and the ledger is stale. |
| Final `node --test scripts/check-sentry-config.test.mjs` | 18/18 passed | Latest classifier after independent adversarial syntax regressions; tracked working-tree assertion passes. Broader run above preceded the final syntax additions in this file. |
| `python3 scripts/ui-review/check-ai-motion.py` | 34 rendered scenarios passed in the preceding UI wave | 320/360/390 widths, light/dark/AMOLED, standard/large text, lifecycle and keyboard-visible states, reduced motion, scrolling and interrupted swaps. |

The browser harness lives in `scripts/ui-review/`; generated
artifacts are at `/tmp/opencode/ai-motion-evidence/results.json` and sibling PNGs.
That temporary directory is local evidence, not a portable release artifact.

Independent read-only reviews:

- AI routing, descriptor gate, catalogue geometry, and shared motion:
  `ses_ec5f56015ffez0euitlLaVsKqC` — PASS after closing adversarial findings.
- Auth/account-reset wave: `ses_ec5c87460ffewoufFn6HV7wzCY` — PASS after
  failing-first regressions and fix-forward iterations. Reviewer independently
  reran 113 tests across auth integration, session, and real auth-service files.
- Upload-token hygiene repair: `ses_ec5935685ffeRf39PiP4walRjX` — PASS.
  Reviewer independently reran 18 tests, exercised all 28 retained negative
  cases plus additional syntax counterexamples, and checked output privacy.
- Acceptance documentation: `ses_ec59e3ab6ffehqyBcpuwhbfjrv` — PASS for the
  initial reconciliation; the subsequent hygiene result updates are recorded
  here without promoting release acceptance.

Reviewer PASS applies to these host/source waves. It does not certify live SDK
ordering on hardware, native inference, hosted migration application, or release.

## Remaining gates and blockers

- Targeted Sentry upload-token hygiene is now passing. It is not a comprehensive
  secret/history scan and does not prove source-map upload, exact-release
  symbolication, or an actual signed-device telemetry event.
- Completion source binding remains stale and the working tree is dirty. Do not
  restamp the ledger as exact-head evidence before source integration and final
  reconciliation. Historical beta waivers do not establish current acceptance.
- Hosted deletion fence `20261014010000` and `delete-account` deployment remain
  live-pending. Apply and verify the fence before deploying the consumer; then
  prove unauthenticated refusal and disposal of a dedicated test account.
- No physical Android acceptance is recorded for this wave. Exact signed
  install/upgrade, Google sign-in, inference/performance/residency, gestures,
  emoji/IME/accessibility, FCM delivery/reply, App Links, and Sentry symbolication
  require candidate/device evidence.
- Whole-app rendered review is incomplete; the 34 scenarios cover AI settings
  and shared transitions, not every route.
- Exact-final-SHA remote CI, shipping KLIPY configuration, hosted SMS/recovery
  proof, and a rebuilt signed candidate with config/provenance remain open.
  Advanced-model import/evaluation is unavailable, not a shipped runtime lane.

No web/APK build, hosted migration/deployment, destructive live test, release
tag/publication, commit, or push is performed by this host verification record.
