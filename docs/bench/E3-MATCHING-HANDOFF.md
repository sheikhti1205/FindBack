# E3-MATCHING candidate — 2026-10-23

Status: **candidate only; independent acceptance pending; no new commit**.
Owned detached worktree `/home/sheikh/fb-work/E3-MATCHING`, base
`57ccae9e0c4b0468b27f38744d68a51c43c5f31f`. Latest instruction prohibits a
commit before independent review. Nothing was applied to any hosted project.
No device, browser, rendered screenshot or screen-reader proof exists. §13.7
remains OFF. No recovery RPC or recovery/ratings service was edited or called.

## Four slices

1. **Reasons — implemented, bounded by real evidence.**
   `services/similarity.ts:173` derives category equality, positive date bonus,
   and positive coordinate proximity bonus. `:186` tests explanation support;
   `:237` feeds consumer strings into ranked matches. Location wording is
   “Within 5 km” / “Within 20 km”, never “same location” from a label alone.
   Dates describe **event dates**, not when reports were created. Same-date,
   whole-day, fractional-day and missing/invalid/out-of-window cases do not
   fabricate report-date facts. Cards render a small explanation list at
   `components/PossibleMatches.tsx:215`.
   There are only three independently attributable existing bonuses. Combined
   title+description embeddings cannot support separate title/detail reasons.
   Photo URLs are presentation-only. The resumed draft's lexical heuristics,
   same-label explanation and photo-presence filler were removed rather than
   inflating the reason count. Zero/one/two supported reasons stay that way.
   No cutoff, weight, score saturation or tie-break calibration changed.

2. **Top five — implemented.**
   `similarity.ts:15,196` caps shipping output at five; the UI shares that cap
   at `PossibleMatches.tsx:148`. A shorter list states its actual count and
   “Up to 5 are shown,” not a measured confidence claim. The server reader,
   twenty-candidate bound, native 21-text batch and blocked-author shield are
   unchanged. Unavailable results still produce unavailable UI and no list.

3. **Evaluation — implemented as a deterministic offline policy evaluation.**
   `services/matchingEvaluation.ts:182,264` validates and evaluates twelve
   labelled synthetic lost/found-style comparisons. The fixture supplies
   synthetic base scores: **no embedding model is exercised**. The canonical
   fixture is `tools/bench/matching-reasons-fixtures.v1.json`, with a vendored
   mobile-test copy. `tools/bench/run-matching-reasons-eval.mjs` runs the actual
   TS ranker, actual derivation and support helper; it rejects fixture drift.
   Report: `docs/bench/matching-reasons-eval-v1.json`. Fixture-declared date:
   2026-10-23; resumed verification actually ran on 2026-10-22 local machine
   time. Date is fixture metadata, not an invented device measurement date.
   The report explicitly refuses a matching-quality claim. Twelve synthetic
   cases cannot validate model quality, multilingual performance, live report
   relevance or server-pool recall.

4. **Visual matching — not available in this build; assessment only.**
   `embeddings.ts:4-6,76-82` accepts text strings only.
   `ai/applicationAi.ts:308` wires text embedding; `:310-314` vision emits
   descriptions, not image vectors; `:1011-1019` Needle embeds text.
   `ai/vision/native.ts:6-14` has describe/generate operations and no image
   embedding operation. Native USE uses MediaPipe **TextEmbedder** in
   `android/.../vlm/UniversalSentenceEmbedder.kt:4,33-44`.
   No verified image encoder is exposed to this comparison. A VLM description
   is not an image vector. No visual flag, stub, fake signal, download or model
   run was added. Minimal real plan: qualify/pin an image encoder; expose an
   image->validated-vector bridge with readiness and residency ownership;
   sequentially schedule it through the canonical AI owner; use approved
   normalized media via the canonical pipeline; specify missing-photo and
   inference-failure policy; measure image cosine/rerank weights on labelled
   device pairs before enabling any visual explanation. Do not gate text
   matching on an optional missing image capability.

## Measured numbers (not a benchmark)

12 cases, 11 carrying relevant candidates, 29 returned suggestions:

| Metric | Actual result |
|---|---:|
| Precision@1 | 0.9166666666666666 |
| Precision@3 | 0.47222222222222215 |
| Precision@5 | 0.4611111111111111 |
| Recall@1 | 0.9090909090909091 |
| Recall@3 | 0.9545454545454546 |
| Recall@5 | 0.9545454545454546 |
| MRR | 1 |
| Mechanical reason support | 65/65 = 1 |
| Hand-labelled relevant-candidate signal agreement | 24/24 = 1 |
| Suggestions with fewer than 3 reasons | 15/29 |

Precision denominator is **min(k, returned)**, not fixed k. Recall is averaged
over the eleven cases with positives. The no-relevant case contributes to
precision. Reason support is a consistency check against production derivation,
not independent verification of item identity; hand labels check relevant
candidate signal coverage separately. Reason histogram: 0:1, 1:5, 2:9, 3:14.
The broad frozen raw-cosine cutoff admits weak comparisons; no claims of
calibrated similarity or recovered items are made. The cap can still miss a
relevant sixth candidate. Synthetic base scores deliberately do not establish
on-device model accuracy.

Exact focused reproduction, from worktree root:

```sh
~/.config/opencode/bin/heavy-run node --experimental-strip-types tools/bench/run-matching-reasons-eval.mjs docs/bench/matching-reasons-eval-v1.json
~/.config/opencode/bin/heavy-run node --experimental-strip-types tools/bench/run-matching-regression.mjs docs/bench/matching-regression-v1.json
```

Two fresh reason-evaluation runs produced identical bytes, SHA256
`32d2a9481e5fa088be90f45b94f7fee9c75726c2ef615e4b11843df1f26eb8ab`.
Regression runner: `{"count":6,"recallAt1":0.6666666666666666,"recallAt3":0.8333333333333334,"mrr":0.75,"ndcgAt3":0.7718216255952429}`.

## Confirmation contract and main drift

Exported `PossibleMatchesProps` has optional
`onConfirmMatch?: (match: PossibleMatch) => void` (`PossibleMatches.tsx:15-26`).
The button is a sibling of the report link (`:224`); no nested control. The
callback receives the safe candidate projection, score and reason strings.
Without it, the UI says confirmation is unavailable and offers report detail
navigation, with no fake disabled button or successful write claim.

The callback must **open the coordinator's real confirmation/recovery flow**;
it must not treat a suggestion click as a successful recovery. Async pending,
authorization, error handling, refresh and recovery navigation belong to that
flow. It must resolve actual lost report ownership and participant identity:
safe `MatchCandidate` deliberately contains no author/user ID and cannot by
itself supply `helperUserId`. Do not silently widen that projection.

Read-only comparison against main `82046e8` found the pipeline baseline
unchanged (SHA256 `46b16795f2f2ba1454294f295d8e04c6e4f712fbbd71938d9e348f418c22932e`).
Main's `services/trust.ts` now owns `markRecovered(MarkRecoveredInput)` and
returns the recovery relationship ID. Its input needs a lost `postId`, helper
kind and, for a FindBack participant, the resolved other user's ID. The card
does not know these facts and makes no RPC call. No trust service was copied.

Proposed integration only, **not applied** to coordinator-owned PostDetail:

```diff
- <PossibleMatches post={post} />
+ <PossibleMatches post={post} onConfirmMatch={(match) => {
+   // Open the existing recovery flow with target report + candidate report ID.
+   // Resolve ownership/participant safely there; require explicit confirmation.
+   openRecoveryFlow({ targetPostId: post.id, candidatePostId: match.post.id });
+ }} />
```

`openRecoveryFlow` above denotes the wiring lane's flow, not a newly shipped
function. No route has been invented. Recovery deep-link/rating navigation
must use the real returned recovery ID after the service succeeds.

## Verification (focused, no build or native run)

From `apps/mobile`:

```sh
~/.config/opencode/bin/heavy-run npx vitest run src/services/similarity.test.ts src/services/similarity.metrics.test.ts src/services/matchingEvaluation.test.ts src/services/possibleMatches.test.ts src/components/PossibleMatches.test.tsx src/components/PossibleMatches.serverPool.test.tsx src/components/PossibleMatches.lightbox.test.tsx --maxWorkers=2
```

Fresh output: `Test Files 7 passed (7)`; `Tests 72 passed (72)`;
`Start at 22:32:29`; `Duration 3.82s`; exit 0.

From root:

```sh
~/.config/opencode/bin/heavy-run npx tsc --noEmit -p apps/mobile/tsconfig.json
~/.config/opencode/bin/heavy-run npx eslint apps/mobile/src/components/PossibleMatches.tsx apps/mobile/src/components/PossibleMatches.test.tsx apps/mobile/src/services/similarity.ts apps/mobile/src/services/similarity.test.ts apps/mobile/src/services/possibleMatches.ts apps/mobile/src/services/possibleMatches.test.ts apps/mobile/src/services/matchingEvaluation.ts apps/mobile/src/services/matchingEvaluation.test.ts tools/bench/run-matching-regression.mjs tools/bench/run-matching-reasons-eval.mjs
git diff --check
```

Results: `TSC_EXIT=0` (no diagnostics); `ESLINT_EXIT=0` (no diagnostics);
`DIFF_CHECK_EXIT=0`. Earlier preserved-draft run failed 3/78 tests (wording,
same-label location precedence, capped photo reason) and first typecheck
failed on a missing non-null assertion in a fixture test. The explanation
model was corrected rather than preserving unsupported signals; final focused
checks above passed. Direct LSP was attempted but refused this detached
worktree as outside the session project; compiler proof is the actual check.

## Scope and remaining acceptance

The wave-plan row includes server prefilter/local text/optional visual/
structured rerank/reasons/confirmed recovery/evaluation. This lane does NOT
claim that full row complete: server reader and text capability are preserved,
not re-proven hosted/native; structured rerank is not added (no verified
matching-rerank strategy in ApplicationAi); confirmation/recovery is a prop
contract only; visual is unavailable; model calibration stays outstanding.
Independent read-only review, rendered 320dp/large-text/theme checks, physical
native matching and end-to-end confirmed recovery remain coordinator gates.
No new branch or commit; no hosted action, credentials, installs or builds.
