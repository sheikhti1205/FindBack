# Owned completion handoff — Map / generation guard / matching / motion fixture

Base: main `b472a24`. No builds, commits, pushes, or edits to another worker's
UI/auth/photo/gates/current-doc/version files. Other workers changed this shared
worktree concurrently; their diffs are not part of this handoff.

## Audit availability / scope

FBA-012/013/016/021 and a completion-audit file were not present in the supplied
tree. Glob/Grep, Serena's whole-project search with ignored files included, and
`git ls-files '*audit*' '*AUDIT*' '*completion*'` found no audit to read. Therefore
this handoff addresses the explicit requested work, **not an audited closure of
those IDs**. Supply the audit to map these results to its exact acceptance rows.

The requested `services/__tests__/motionPhotoParser.test.ts` did not exist; it
was created at that owned path. The current parser is
`services/media/motionPhoto.ts`; it was only read. The original optional real
Xiaomi test remains unchanged at `services/media/motionPhoto.real.test.ts`.

## Files changed (owned diff only)

Modified:
- `apps/mobile/src/components/MapPickerSheet.test.tsx`
- `apps/mobile/src/services/ai/generationGuard.ts`
- `apps/mobile/src/services/ai/generationGuard.test.ts`
- `apps/mobile/src/services/similarity.ts`
- `apps/mobile/src/services/similarity.test.ts`

Added:
- `apps/mobile/src/services/__tests__/motionPhotoParser.test.ts`
- `apps/mobile/src/services/__tests__/motionPhotoFixture.ts`
- `tools/bench/matching-ranking-fixtures.v1.json`
- `tools/bench/run-matching-regression.mjs`
- `docs/bench/matching-policy.md`
- `docs/bench/corpus-v1-comparison.json`
- `docs/bench/matching-regression-v1.json`
- this handoff

`MapPickerSheet.tsx`, `similarity.metrics.test.ts`, shared AI contract modules,
and the real media parser needed no implementation change.

## Unified-diff summary / contracts

- Map test harness: static motion DOM retains real BottomSheet semantics/ref
  wiring, supplies nonzero jsdom host geometry, waits for map event registration
  before search camera assertions, delivers map events inside `act`, and
  explicitly invokes the captured load-deadline callback. No timeout enlargement;
  the old 3-second stall-test wait was removed. Additional controlled RAF tests
  cover construction after exactly two zero-layout frames and close-before-frame
  completion. No shipping map behavior changed.
- Guard: repository import search found only `generationGuard.test.ts` importing
  this module; the release-gate script mentions it in a comment only. Serena
  `guardedGenerate` references counted **26, all in that test file**. This guard
  is the lab orchestration seam, not the shipping AiResult/AiError/action layer.
  Removed obsolete rewire/TBD comments in the owned guard, explicitly documenting
  lab ownership and a caller-selected per-attempt deadline: omission disables
  the guard timer only, provider timeouts remain valid, and guard deadline aborts
  suppress retries. A fake-clock regression advances 120 seconds with the
  deadline omitted, proves the request is still pending/unaborted, then resolves
  successfully. No runtime behavior or shared action allowlist changed; no claim
  that a future shipping integration has been completed. Other modules' timeout
  prose is outside this ownership and was not edited.
- Matching: freeze the existing shipping caller policy at raw cosine 0; preserve
  the standalone utility's no-cutoff behavior. Added six labeled score fixtures
  and actual TS ranker/metric execution, including honest saturation-tie and
  top-three misses. Candidate-order reversal is checked. No threshold/score
  algorithm change. The DEVICE-CALIBRATION TODO remains explicitly outstanding.
- Motion fixture: generated, self-owned 16x16 JPEG still with a length-correct
  APP1/XMP declaration, 0/8/32-byte zero padding, and a complete encoded one-frame
  MP4 tail. Five mandatory tests run without optional input: boundary extraction,
  dimensions, byte-accurate stripping, determinism/MP4 boxes, and truncation.
  No real user/vendor bytes were embedded. The optional real Xiaomi sample is
  supplemental only; its absence cannot skip these five CI tests.

## Verification evidence

### RED/GREEN and interim diagnostics

- Baseline four suites: **72 passed / 4 files**.
- Map readiness RED: focused search test failed because `handlers.moveend` was
  `undefined` immediately after the DOM host mounted. The harness fix then
  passed all original **23 map tests**; later added controlled RAF regressions
  brought the final suite to **25**. No production map changes.
- Motion fixture RED: without APP1/XMP all three padding variants failed with
  `null` detection. After inserting XMP a fixture transcription error triggered
  strict dimension-probe failures; it was corrected against the generated JPEG.
  GREEN: **5/5**. Independent native decoding later passed for still and video.
- Matching/guard tests characterize frozen existing behavior; production edits
  in these modules are comments only, so no behavioral fix/RED is claimed.
- First mobile typecheck encountered concurrent, outside-scope photo-grounding
  missing-component/input-contract errors. A later check caught an owned JSON
  union-array inference error after descriptive fixture titles were added; fixed
  the local test helper's input typing. Final mobile typecheck **exit 0**.

### Ten independent clean map runs

Exact command:

```sh
for run in {1..10}; do npm run test -w apps/mobile -- src/components/MapPickerSheet.test.tsx || exit 1; done
```

All **10/10 fresh Vitest processes**, **25 tests each = 250 passes**, no failures,
skips, React warnings, or stderr diagnostics. Durations (seconds):
5.03, 4.70, 4.71, 7.91, 6.03, 15.01, 10.04, 5.57, 6.07, 5.08.
The harness was not changed after these runs.

### Final focused run / lint / typecheck

Exact final command:

```sh
npm run test -w apps/mobile -- src/components/MapPickerSheet.test.tsx src/services/ai/generationGuard.test.ts src/services/similarity.test.ts src/services/similarity.metrics.test.ts src/services/__tests__/motionPhotoParser.test.ts src/services/media/motionPhoto.edge.test.ts src/services/media/motionPhoto.real.test.ts src/services/possibleMatches.test.ts && npx eslint apps/mobile/src/components/MapPickerSheet.test.tsx apps/mobile/src/services/ai/generationGuard.ts apps/mobile/src/services/ai/generationGuard.test.ts apps/mobile/src/services/similarity.ts apps/mobile/src/services/similarity.test.ts apps/mobile/src/services/__tests__/motionPhotoParser.test.ts apps/mobile/src/services/__tests__/motionPhotoFixture.ts tools/bench/run-matching-regression.mjs && npm run typecheck -w apps/mobile && git diff --check
```

Result: **115 passed, 1 skipped; 7 files passed, 1 skipped; 4.06 s**.
The single unchanged skip is the optional private real-Xiaomi sample, not the
generated suite. All five generated fixture tests passed. ESLint, mobile
typecheck and diff whitespace check each exited **0**.

Earlier focused commands (all from repo root):

```sh
npm run test -w apps/mobile -- src/components/MapPickerSheet.test.tsx src/services/ai/generationGuard.test.ts src/services/similarity.test.ts src/services/similarity.metrics.test.ts
npm run test -w apps/mobile -- src/components/MapPickerSheet.test.tsx -t "searches only on submit"
npm run test -w apps/mobile -- src/components/MapPickerSheet.test.tsx
npm run test -w apps/mobile -- src/services/__tests__/motionPhotoParser.test.ts
npm run test -w apps/mobile -- src/components/MapPickerSheet.test.tsx src/services/ai/generationGuard.test.ts src/services/similarity.test.ts src/services/similarity.metrics.test.ts src/services/__tests__/motionPhotoParser.test.ts
npm run test -w apps/mobile -- src/services/ai/generationGuard.test.ts src/services/similarity.test.ts src/services/similarity.metrics.test.ts src/services/__tests__/motionPhotoParser.test.ts src/services/media/motionPhoto.edge.test.ts src/services/media/motionPhoto.real.test.ts src/services/possibleMatches.test.ts
```

The five-suite intermediate run passed **89** tests; the non-map final-support
run passed **90** with the same one optional sample skipped. The final command
above includes both for **115** actual test passes, not duplicated evidence.

### Corpus and policy metrics

```sh
ls docs/bench && node tools/bench/runBench.mjs --corpus tools/bench/corpus.v1.json --out docs/bench/corpus-v1-comparison.json --app-sha b472a24 && node --experimental-strip-types tools/bench/run-matching-regression.mjs docs/bench/matching-regression-v1.json
```

- Existing labeled synthetic corpus: **12 pairs**, both token-overlap stub and
  category-boosted fake: Recall@1/3, MRR, nDCG@3 **1.0**. This is not native
  inference or the shipping ranker. The unchanged harness's `photoCases`
  section imports historical results (`total=6`, `executed=8`) with no fresh
  execution or case mapping; do not use that section as this pass's evidence.
- Actual ranker on six synthetic mapped-score regressions: Recall@1 **0.666667**,
  Recall@3 **0.833333**, MRR **0.75**, nDCG@3 **0.771822**. Runner exit **0**;
  fixture path/title cleanup was followed by a fresh runner execution with the
  same metrics. Reports and policy are stored beside this handoff.

### Encoded fixture generation and independent decode

Payload generation was stdout only, no app/native build:

```sh
ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=16x16:r=1 -frames:v 1 -threads 1 -c:v mjpeg -f image2pipe pipe:1 | base64 -w 0
ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=16x16:r=1 -frames:v 1 -threads 1 -c:v mpeg4 -flags +bitexact -map_metadata -1 -movflags frag_keyframe+empty_moov -f mp4 pipe:1 | base64 -w 0
```

Independent final decoder command:

```sh
node --experimental-strip-types --input-type=module -e 'import { generatedMotionPhoto } from "./apps/mobile/src/services/__tests__/motionPhotoFixture.ts"; import { spawnSync } from "node:child_process"; import { strict as assert } from "node:assert"; const f=generatedMotionPhoto(); for(const [kind,input] of [["JPEG",f.bytes.subarray(0,f.stillEnd)],["MP4",f.video]]) {const r=spawnSync("ffmpeg",["-hide_banner","-loglevel","error","-i","pipe:0","-frames:v","1","-pix_fmt","gray","-f","rawvideo","pipe:1"],{input}); assert.equal(r.status,0,String(r.stderr)); assert.equal(r.stdout.length,256); console.log(kind+" decode exit="+r.status+" decoded-gray-bytes="+r.stdout.length+" stderr="+r.stderr);}'
```

JPEG and MP4 each **decode exit=0, 256 grayscale bytes (16x16), stderr empty**.
CI tests do not require ffmpeg; they use the deterministic encoded constants
and real parser/prober. Browser/native decoder fidelity is not claimed from
jsdom.

## External blockers / not verified / next action

- Completion audit absent: provide FBA-012/013/016/021 to verify exact mapping.
- Native matching calibration: `build/needle/needle3.cact` and
  `build/needle/engine-x86_64/libneedle.a` exist; `build/needle/embed-probe` does
  not. `build/needle/needle-cli --help` exited 0 but offers no complete-vector
  embedding output. The source probe emits only three vector coordinates. A
  full-vector executable/device adapter must be provisioned separately; builds
  were explicitly prohibited. No claim of native inference impossibility in
  general, only that this matching measurement path is unavailable this pass.
- Real private Xiaomi sample absent (unchanged supplemental test skipped).
  Generated container tests and native decodes do not prove every vendor variant.
- No APK/web/native build, device run, network model run, full repository suite,
  API typecheck, full-repo ESLint, or release-gate execution. No sharing/reading
  of secrets. No commit/staging/push. Current parallel-worker diffs need their
  own verification; this handoff does not certify them.

Next action: consume this owned diff and evidence; obtain the missing audit,
then arrange real native full-vector/device calibration and optional vendor
sample verification without treating the synthetic results as device evidence.
