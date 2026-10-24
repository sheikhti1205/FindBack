# FindBack history inventory — reconstruction pending

**Status: NOT an accepted product-version history.** FindBack remains beta/pre-public.
This 2026-10-24 correction replaces unsupported review percentages, guessed product
versions and misleading release assertions. It does not rewrite Git history.

## Scope and evidence

[VERSION_HISTORY.csv](VERSION_HISTORY.csv) preserves the frozen intake's 854
identities, provisional r0001–r0854 order, original author timestamps and subjects.
The intake ends at `e0fbb0de0f03a541557f47157d783790aa4b3cc4` for main; it also
includes historical side-ref commits. Its recorded reachability is 818 main-reachable
and 36 not main-reachable. It is **not** a complete inventory of today's HEAD:
subsequent forward commits require a supplemental audit and map.

The CSV uses the ten columns required by R3. `commit_sha = original_commit_sha`
means **no rewrite has occurred**. `product_version` and `phase` are deliberately
`UNASSIGNED`. Empty tag/release cells mean not audited, not that no tags/releases
exist. Original package declarations in `notes` are metadata, not product maturity,
deployment, compatibility or release acceptance.

The frozen private inspection register records:

| Recorded state | Rows | Evidence scope |
|---|---:|---|
| Complete maintenance-diff observations | 10 | r0481–r0485, r0487–r0489, r0491, r0499; independently corroborated by the narrow correction review |
| Preliminary selected-source/subject triage | 490 | Not meaningful full-diff approval |
| Unreviewed | 354 | No complete-patch claim |

The register's ten rows retain their original pending-review label; the later
private `audit-20261024/INDEPENDENT-REVIEW-001.md` corroborates those ten only.
The other **844 rows still require meaningful-diff disposition**. This is the
scope supported by the located artifacts, not a claim that no other useful work
ever occurred. Prior estimates of 270, 356, 856 or 100% inspected are withdrawn:
`git show --stat | tail -2`, repeated counts and checksum checks cannot prove
patch reading. No rows, including governance-only commits or merges, are silently
excluded as “noise.”

## Observed package declarations, not reconstructed milestones

The following intervals were cross-checked against both package blobs for all
854 frozen commits (1,708 reads). Root and mobile declarations agree. This is
metadata verification only; capability boundaries remain to be reviewed.

| Provisional interval | Declared package version |
|---|---|
| r0001–r0189 | 0.1.0 |
| r0190–r0324 | 0.1.0-beta.1 |
| r0325–r0336 | 0.2.0-beta.1 |
| r0337–r0339 | 0.2.0-beta.2 |
| r0340–r0362 | 0.2.0-beta.3 |
| r0363–r0403 | 0.3.0-beta.1 |
| r0404 | 0.4.0-beta.1 |
| r0405 | 0.4.0-beta.2 |
| r0406–r0429 | 0.4.0-beta.3 |
| r0430–r0433 | 0.5.0-beta.1 |
| r0434–r0443 | 0.6.0-beta.1 |
| r0444–r0447 | 0.7.0-beta.1 |
| r0448–r0469 | 0.7.0-beta.2 |
| r0470–r0485 | 0.8.0-beta.2 |
| r0486–r0531 | 0.9.0-beta.1 |
| r0532–r0696 | 1.0.0 |
| r0697–r0854 | 2.0.0-beta.1 |

In particular, the old document incorrectly extended `0.4.0-beta.2` through
r0429. The historical `1.0.0` string is **not proof of a satisfied stable-release
gate**. No reconstructed current version will be guessed from these intervals.

## Reproduction and remaining work

`scripts/generate-history-inventory.py` is a metadata-only stdin/stdout converter
for the frozen private `HISTORY-MAP-DRAFT-001.csv`. It validates contiguous
revision IDs, unique SHA identities, timezone-bearing dates and parent-before-child
input order. It does **not** verify Git truth, complete ref coverage, inspected
paths, product versions or hosted migrations. Write its output to a candidate
file before replacing the public CSV; do not use it to overwrite a later reviewed
version map. Focused tests:

```sh
python3 -B -m unittest discover -s scripts -p test_generate_history_inventory.py -v
```

The correction's private `verify_rebaseline_metadata_002.py` additionally compares
identities, ordered parents, subjects, timestamps and declarations with Git, and
both packet ZIPs with their retained extractions. This is still not a semantic
history audit. The original public artifacts are retained privately and in Git.

Next: inspect every meaningful diff and merge with path coverage, reconcile
authored/committed chronology without inventing dates, assign evidence-derived
dev/alpha/beta milestones, include forward commits, and independently review the
old-to-new map and release plan. Before any destructive ref/release/history work,
verify complete private restoration including dirty worktrees; the existing
refs/releases/assets PASS is narrow and excludes that dirty state. No destructive
operation is authorized by this document. See the
[acceptance status](ACCEPTANCE_EVIDENCE_REPORT_2026-10-24.md).
