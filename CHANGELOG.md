# Changelog

FindBack is **beta / pre-public**. Versions below are the derived pre-1.0 line
described in [docs/history/VERSION_HISTORY.md](docs/history/VERSION_HISTORY.md). They
track real evolution and do not imply a stable release. The per-commit mapping is in
[docs/history/VERSION_HISTORY.csv](docs/history/VERSION_HISTORY.csv).

## 0.12.0-beta.1 — product coherence (source checkpoint)

- Unified phone/desktop navigation, adaptive split views, anchored actions,
  task/confirmation surfaces and a shared zoomable photo viewer.
- Compact reports/comments, contextual desktop report details, shared Create/Edit
  editor, clearer matching/recovery and Settings/Profile organization.
- Reports/People discovery, notification quick view, canonical Chats with request
  flows, mute, personal Archive, report context and explicit static location.
- Removed retired local-generative runtime/lab tooling while retaining on-device
  Smart Search, Needle/USE matching, upgrade cleanup and separate optional cloud Chat.
- Repaired content erasure/exact replay, report-preview revocation, account-bound
  publication and stale editor continuations. Ambiguous already-erased legacy
  send identities fail closed rather than falsely acknowledging changed content.
- Local source/fixture acceptance only. Four new migrations remain **LIVE-PENDING**;
  nothing is deployed or released by this version change. Real-account/browser,
  physical Android, Sentry and owner phone-photo corpus acceptance remain unpassed.
  See [source checkpoint](docs/releases/M7_P_SOURCE_CLOSURE_2026-11-01.md).

## 0.11.0-beta.2 — functional freeze

- Functional freeze recorded in
  [docs/releases/BETA_FUNCTIONAL_FREEZE_2026-10-30.md](docs/releases/BETA_FUNCTIONAL_FREEZE_2026-10-30.md):
  frozen source, test totals, live migration head, deployed function inventory and
  the named external gates that remain.
- Matching/recovery, private chat R4, trust/staff flows and consumer/native truth
  closed in the preceding interval; this interval reconciles the integrated gates
  and records the freeze.

## 0.11.0-beta.1 — product breadth

- Largest feature interval: matching and recovery, private chat, trust and
  moderation, native integration and backend function work, with a long tail of
  fixes across client and server.
- Cloud functions and runtime deployment sets brought in line with the source.

## 0.10.0-beta.1 — pre-1.0 line correction

- Governance, ledger, agent-instruction and map/capability work.
- The earlier `1.0.0` label claimed a stable release that never shipped; the project
  stays on the pre-1.0 beta line. Nothing was removed — this period's work is kept
  under the corrected version.

## 0.9.0-beta.1 — assistant landing

- Assistant landing, neutral palette and a security closure wave.

## 0.8.0-beta.2 — ledger and dependency reconciliation

- Completion-ledger reconciliation to the beta.2 bump, non-breaking dependency
  audit fixes, and release/documentation corrections.

## 0.7.0-beta.2 / 0.7.0-beta.1 — capability truth

- Assistant mode unified under account-scoped preferences; user-facing AI and cloud
  connection claims corrected on client and server.

## 0.6.0-beta.1 — account-scoped AI preferences

- AI preferences persisted per account, Help converged onto the intent router and a
  grounded help operation.

## 0.5.0-beta.1 — on-device photo engine

- On-device SmolVLM2 became the default report-photo engine; release-gate tests made
  environment- and timing-independent.

## 0.4.0-beta.3 / .2 / .1 — native release pipeline and design system

- Signed per-ABI Android builds, pinned NDK provisioning and exact per-ABI asset
  checks; settings and appearance design system with contrast and AMOLED handling.

## 0.3.0-beta.1 — AI orchestrator

- Typed-proposal orchestrator contract and the first substantial on-device AI wave.

## 0.2.0-beta.3 / .2 / .1 — feed, sharing and report redesign

- Home feed cards and filters, nearby discovery, report redesign with photo-viewer
  fixes, canonical report sharing and App Links.

## 0.1.0-beta.1 — first declared beta

- Signed beta pipeline, strict release preflight, manual backend deploy and the
  first beta release notes.

## 0.1.0-alpha.1 — early app

- Recognizable app: feature screens and routing, feed and comments, API and database
  work, with rapid architectural change.

## 0.0.1-dev.1 — scaffold

- Monorepo scaffold with the local Node API and SQLite store; no usable consumer
  flow yet.

---

Older generated changelog text that attributed later work to earlier intervals, or
listed unimplemented behaviour, is withdrawn rather than silently carried forward.
The original text remains recoverable in Git history.
