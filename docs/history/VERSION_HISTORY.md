# Version history

FindBack is **beta / pre-public**. This page describes how the project's versions are
derived, what each interval contains, and what the history does *not* prove. The
per-commit record is [VERSION_HISTORY.csv](VERSION_HISTORY.csv) — one row per source
commit, `r0001`–`r0895`.

## How versions are derived

Versions are derived from evidence, not guessed:

1. the real Git DAG (`git rev-list --reverse main`), parents and order;
2. the `version` declared in `package.json` and `apps/mobile/package.json` at each
   commit (the two always agree);
3. existing tags and release metadata;
4. pre-1.0 SemVer semantics: dev before a usable flow, alpha while the app is
   recognizable but changing fast, beta when broadly usable but pre-public, and RC
   only once the 1.0 feature set is frozen.

Declared values are kept in the CSV as historical facts (`declared_version`). The
derived line (`product_version`) corrects only labels that are not supportable:

| Correction | Reason |
|---|---|
| `0.1.0` → `0.1.0-alpha.1` (r0002–r0172) | pre-beta; architecture and flows still changing |
| `1.0.0` → `0.10.0-beta.1` (r0514–r0678) | claimed a stable 1.0 while the product was pre-public and incomplete |
| `2.0.0-beta.1` → `0.11.0-beta.1` (r0679–r0893) | skipped the unreleased 1.0 line |
| — → `0.11.0-beta.2` (r0894–r0895) | functional beta freeze |

Current derived version: **0.11.0-beta.2**.

## Intervals

| Version | Revisions | Summary |
|---|---|---|
| 0.0.1-dev.1 | r0001 | monorepo scaffold, local Node API and SQLite store |
| 0.1.0-alpha.1 | r0002–r0172 | app screens and routing, feed, comments, API/database work |
| 0.1.0-beta.1 | r0173–r0306 | signed beta pipeline, release preflight, manual backend deploy |
| 0.2.0-beta.1 | r0307–r0318 | home feed cards and filters, nearby discovery |
| 0.2.0-beta.2 | r0319–r0321 | report redesign and photo-viewer fixes |
| 0.2.0-beta.3 | r0322–r0344 | canonical report sharing, App Links, capabilities, inbox |
| 0.3.0-beta.1 | r0345–r0385 | AI orchestrator and typed-proposal contract |
| 0.4.0-beta.1 / .2 / .3 | r0386 / r0387 / r0388–r0411 | release plumbing, pinned NDK, settings/appearance design system |
| 0.5.0-beta.1 | r0412–r0415 | on-device SmolVLM2 default report-photo engine |
| 0.6.0-beta.1 | r0416–r0425 | account-scoped AI preferences, Help intent router |
| 0.7.0-beta.1 / .2 | r0426–r0429 / r0430–r0451 | assistant mode unification, capability truth corrections |
| 0.8.0-beta.2 | r0452–r0467 | completion ledger reconciliation, dependency audit fixes |
| 0.9.0-beta.1 | r0468–r0513 | assistant landing, neutral palette, security closure |
| 0.10.0-beta.1 | r0514–r0678 | governance/ledger/agent/map work |
| 0.11.0-beta.1 | r0679–r0893 | matching, chat, trust, native and backend breadth |
| 0.11.0-beta.2 | r0894–r0895 | functional freeze gates and freeze record |

## Tags

Existing tags are re-pointed to the rewritten commits of the same interval. `v1.0.0`
became `v0.10.0-beta.1`; no other tag was renamed. A tag marks an interval boundary,
not a stable release, and several intervals never had a tag.

## What this history does not prove

- It is not an acceptance record. Tests, device runs and hosted verification are
  recorded separately; a version existing says nothing about a device passing.
- It is not a migration record. Applied migration bytes are tracked separately and
  are immutable.
- It is not a claim that every commit was adversarially reviewed. Version assignment
  uses the DAG, declared versions, subjects and targeted boundary inspection, as
  described above.
- Old release notes that described an unreleased "1.0.0 stable" are withdrawn; the
  original text remains recoverable in Git.
