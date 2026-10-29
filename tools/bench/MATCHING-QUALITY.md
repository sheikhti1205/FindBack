# Practical matching evaluation

Use Node ≥22.18 and the machine-wide heavy wrapper. No build, model download or
network is needed. The shipped `rankTextMatches` and `recallAtK` run unchanged:

```sh
~/.config/opencode/bin/heavy-run node tools/bench/run-matching-quality.mjs \
  /private/session/dataset.json /private/session/new-report.json --iterations=100
```

Output must not already exist. Keep **all real reports, labels and photographs
private**; commit only synthetic fixtures/harnesses. `matching-quality.test.mjs`
tests the real CLI with single-command disposable scratch files.

## Dataset contract: `matching-quality-v1`

Root: `{ "version": "matching-quality-v1", "cases": [...] }`. Each query has:

- `id`, `language` (`en`, `bn`, `banglish`, `mixed`), `origin`;
- `target`, `candidates`: report `id`, `title`, nullable `description`, `category`,
  nullable ISO `eventDate`, nullable `locationLat`/`locationLng`;
- `relevantIds`: unique candidate IDs truly describing the same physical item,
  or empty when no item matches. Never label from the ranker's answer;
- `labelSource`: `authored` for `synthetic`; `observed-same-object` for
  `phone-observation`; `successful-return` for `confirmed-recovery`;
- observed cases require a private `labelReference` and a phone photograph for
  every target/candidate: `photos: [{reportId, path, sha256, source:
  "phone-camera", sanitized: true}]`.

Photos must be consented **item-only sanitized derivatives** from the canonical
media-preparation pipeline (no EXIF/GPS, people, readable IDs, credentials).
Paths must remain inside the dataset directory, including through symlinks.
Hash/magic verification detects drift, **not** privacy/provenance: the supplied
human label and sanitization declarations remain attestations.

## Small, useful collection

Photograph 6–12 actual objects twice, including clutter/poor light. Have a second
person write imperfect descriptions independently; mix English, Bangla and
Banglish, including cross-script pairs. Each query should include at least five
plausible same-category negatives; include date/place traps and no-match queries.
Keep negatives with the same color/object word but different identifying details.
Use observed physical identity for staged collection, not a claimed recovery.
Only consented, verified durable returns can supply `confirmed-recovery` labels;
retain the private evidence reference rather than inferring from report status.

## Interpretation

Recall@1/3/5 is macro-averaged **separately by provenance and language**. A
relevant candidate missing from suggestions is a miss. No-relevant queries stay
out of the recall denominator and their suggestion counts are reported. Candidate
retrieval coverage is not measured by this fixed-pool harness.

Host latency is warm rank-only; RSS/heap are sampled Node-process totals, not
transient peaks or Android/model memory. Storage counts actual dataset/photo and
ranker bytes. Photos are **not analyzed**: this beta harness measures the
text/structured fallback in photo-backed scenarios, never visual matching.
No "Best", model promotion or general real-world claim follows from small staged
data. Report failures, especially cross-script lexical misses; do not tune against
the evaluation set and then call it independent acceptance.
