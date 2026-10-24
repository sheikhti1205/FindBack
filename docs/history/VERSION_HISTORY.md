# FindBack Version History — Draft (R3 Audit)

**Status:** DRAFT — version assignments are boundary-derived, not per-commit diff-reviewed.
**Source:** `VERSION_HISTORY-DRAFT-001.csv` (854 commits, r0001–r0854)
**Recovery bundle:** `findback-full-recovery-20261024.bundle` (SHA256: 3d4161a4db7a6d9bf4aecb3b52283b6d517047f9c8ff9e4cc51ee412ed42390b)
**Generated:** 2026-10-24

## Version Milestones (evidence-derived from release-cut commits)

| rNNNN | Commit | Version | Evidence |
|-------|--------|---------|----------|
| r0001 | 39e9e1686c88 | 0.1.0 (scaffold) | Initial monorepo scaffold, local Node API + SQLite |
| r0190 | f2184a08d726 | 0.1.0-beta.1 | feat(release): signed beta pipeline, manual backend deploy |
| r0325 | 7cf80335543b | 0.2.0-beta.1 | release: prepare v0.2.0-beta.1 |
| r0337 | 40eddb2e4bb2 | 0.2.0-beta.2 | release: prepare v0.2.0-beta.2 |
| r0340 | 90c9b3173b5a | 0.2.0-beta.3 | release: prepare v0.2.0-beta.3 |
| r0363 | 51fced85f844 | 0.3.0-beta.1 | release: prepare v0.3.0-beta.1 |
| r0404 | 55c9093757f5 | 0.4.0-beta.1 | release: cut 0.4.0-beta.1 |
| r0405 | b28ec0288e4f | 0.4.0-beta.2 | release: provision pinned ndk for release builds |
| r0430 | 0ac531965764 | 0.5.0-beta.1 | release: prepare v0.5.0-beta.1 |
| r0434 | 04e15b2b619f | 0.6.0-beta.1 | release: prepare v0.6.0-beta.1 (SmolVLM2 default) |
| r0444 | 4e352830e07c | 0.7.0-beta.1 | release: prepare v0.7.0-beta.1 |
| r0448 | 088d9774f118 | 0.7.0-beta.2 | release: prepare v0.7.0-beta.2 |
| r0470 | 889a17684ce5 | 0.8.0-beta.2 | release: bump to 0.8.0-beta.2 for v8 beta 2 |
| r0486 | 83505e76e456 | 0.9.0-beta.1 | release: v0.9.0-beta.1 assistant landing, neutral palette, security closure |
| r0532 | 00e7343c278e | 1.0.0 (stable) | release: cut 1.0.0 stable version line |
| r0697 | e0e1cefdd7bb | 2.0.0-beta.1 | release: bump version to 2.0.0-beta.1 |

## Commit Count by Version

| Version | Commits | Range |
|---------|---------|-------|
| 0.1.0 (scaffold) | 189 | r0001–r0189 |
| 0.1.0-beta.1 | 135 | r0190–r0324 |
| 0.2.0-beta.1 | 12 | r0325–r0336 |
| 0.2.0-beta.2 | 3 | r0337–r0339 |
| 0.2.0-beta.3 | 23 | r0340–r0362 |
| 0.3.0-beta.1 | 41 | r0363–r0403 |
| 0.4.0-beta.1 | 1 | r0404 |
| 0.4.0-beta.2 | 25 | r0405–r0429 |
| 0.5.0-beta.1 | 4 | r0430–r0433 |
| 0.6.0-beta.1 | 10 | r0434–r0443 |
| 0.7.0-beta.1 | 4 | r0444–r0447 |
| 0.7.0-beta.2 | 22 | r0448–r0469 |
| 0.8.0-beta.2 | 16 | r0470–r0485 |
| 0.9.0-beta.1 | 46 | r0486–r0531 |
| 1.0.0 (stable) | 165 | r0532–r0696 |
| 2.0.0-beta.1 | 158 | r0697–r0854 |

## Chronology Invariants

- All commits are chronologically ordered by author_date (ascending).
- All commits are on main branch (no feature branches created per owner rule).
- Authorship: single author (Sheikh Tawsif Bin Aftab) for all 854 commits.
- Migration count: 65+ SQL migrations applied (latest: 20261024050000).
- Tags: 19 annotated tags (v0.2.0-beta.1 through v1.0.0 + archive tags).

## Known Limitations

1. **Version assignments are boundary-derived**, not per-commit diff-reviewed. Only 10 of 854 commits have had full diff inspection.
2. **No destructive history rewrite has been authorized.** The recovery bundle is a rollback artifact only.
3. **2.0.0-beta.1 is the current development line** (r0697–r0854). No stable release after 1.0.0.
4. **history-publish task requires separate owner approval** before any destructive action (history rewrite, force-push, tag/ref alteration, release edit).

## Files

- `VERSION_HISTORY-DRAFT-001.csv` — full per-commit version assignment (854 rows)
- `HISTORY-MAP-DRAFT-001.csv` — original history map with commit metadata
- `INDEPENDENT-RECOVERY-REVIEW-001.md` — recovery bundle review
- `findback-full-recovery-20261024.bundle` — recovery bundle (SHA256: 3d4161a4...)
path: /home/sheikh/GitHub/FindBack-internal/01_ACTIVE/consumer-final/sessions/main/SUPPLEMENT-R3-2026-10-24/VERSION_HISTORY-001.md