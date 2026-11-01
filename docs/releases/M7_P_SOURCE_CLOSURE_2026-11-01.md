# M7-P source checkpoint — 2026-11-01

Source version: **0.12.0-beta.1**. Internal beta, pre-public. No release/tag/APK,
hosted migration or Edge Function deployment is created by this record.

## Scope

M7-P unifies adaptive navigation, overlays, identity, media inspection, reports,
comments, Chats, Search, Notifications, Settings/Profile and report management.
Retired local-generative execution/tooling was removed by reachability inventory;
Needle/USE matching, Smart Search, lifecycle/upgrade cleanup and separate optional
cloud AI Chat remain. Legal notices and historical records are preserved.

Baseline: `22241f8c8646a60ad679e33b6bb2b863ba3a692f`.
Integrated material-repair checkpoint: `3428409b` (25 scoped paths).
Documentation/version checkpoint is the commit introducing this record. See
[design ownership](../DESIGN_SYSTEM.md) and [architecture](../ARCHITECTURE.md).

## Evidence actually observed

- Shared foundations, viewer and feature checkpoints have focused compiler/lint,
  test and actual-component synthetic Chromium evidence; the final integrated
  source was then re-rendered after material repairs.
- Final repair gate: TypeScript, all changed TypeScript lint, **11 files / 154
  tests**, and diff check pass. This is focused evidence, not a full-suite claim.
- Six full-chain disposable PostgreSQL probes pass: content erasure/exact replay,
  account-bound create, media capture/cleanup race, media evidence cleanup guard,
  original context/location and R4. An additional upgrade sequence exercises the
  real previous send owner, backfill, historical Unsend, deletion/erasure and retry.
- Final rendered gate: **120 route cells + 365 lane cells**, all six integrated lanes exit 0;
  **949 integrated source hashes plus 15 route hashes** match the accepted source.
  Representative final captures were inspected, including the repaired narrow
  match reasons and 320px/200% text, plus phone/landscape/tablet/desktop themes.
- Documentation/version final gate: compiler and affected-source lint pass;
  **21 build/config/version guard tests + 59 route/About tests** pass. Root,
  mobile and lock versions agree; dependency resolutions are unchanged. All 949
  rendered source hashes still match after the docs/version changes. The actual
  release preflight correctly refuses the unrelated dirty workspace.
- One independent integrated audit and its bounded follow-up found material
  issues. The follow-up FAIL is retained as history; coordinator-run regressions
  establish subsequent repairs, not an invented independent PASS.

Raw synthetic fixtures and private evidence stay outside the public repository.
The public [screenshot manifest](../screenshots/manifest.json) identifies the two
older-beta illustrative captures in README; they are explicitly labelled as
predating M7-P, not substituted for the private final-source rendered evidence.

## Backend state — local / LIVE-PENDING

New migrations, **not applied or read back from hosted** in M7-P:

- `20261031010000_m7p_people_search.sql`: authenticated, public-fields-only people
  search with normalization, ranking, bounded keyset pages and safety filters.
- `20261031020000_m7p_chat_mute.sql`: per-user synced notification mute.
- `20261031030000_m7p_chat_context_location.sql`: authorized report context and
  explicit connected-only static location.
- `20261101090000_m7p_chat_content_erasure_immutability.sql`: content erasure,
  exact replay identity/backfill and statement-level account-bound create wrappers
  delegating to existing validation/RLS owners.

Applied migration bytes are unchanged. A future authorized accepted publication
must immediately verify hosted migration state and relevant behavior; pushing
source does not deploy Edge Functions. This record does not authorize deployment.

## Known qualifications

- Exact identities can be backfilled only where the old payload is reconstructable.
  Already-erased legacy content cannot safely be inferred from the old ambiguous,
  rounded digest; its retries fail closed, not falsely succeed. New accepted sends
  preserve exact replay across erasure. No plaintext is reconstructed or retained.
- Normal committed account/route switches clear pending destructive intents.
  The independent audit's narrower captured-acting-viewer defense-in-depth
  qualification is recorded; it was not a reproduced wrong-target exploit.
- One earlier intermittent recovery-opening test observation has no established
  root cause; focused later gates pass. It is not labelled fixed by unrelated greens.
- Release preflight still rejects this workspace's unrelated dirty/private paths.
  Version equality is not clean-tree, signing, bundle-configuration or release proof.

## Deferred and unpassed

Real browser/account (including two-account/staff sessions), physical Android/native,
Sentry ingestion and the owner's multilingual phone-photo matching corpus remain
deferred. No fixture, version change or source checkpoint marks them passed.
The previous beta goal remains archived incomplete; M7-P does not accept its
unfinished release obligations.

**M7-P SOURCE WORK CLOSED — DEFERRED OWNER ACCEPTANCE REMAINS** describes the
local source checkpoint only, not full beta/release/device acceptance.
