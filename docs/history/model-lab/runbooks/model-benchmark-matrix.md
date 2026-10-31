# Model benchmark matrix — lab lane (no production promotion)

> Benchmark lane only. Nothing here promotes a model to Recommended.
> Production Recommended stays exactly Needle (structured text) + SmolVLM2
> 500M vision in `apps/mobile/src/services/ai/modelDescriptors.ts`.
> Every candidate below is Advanced catalogue; every new candidate is
> `integrated-pending-measurement` until the owner hand-picks from measured
> data. Separate axes per `findback-ai-runtime`: model ≠ runtime ≠ role ≠
> maturity. Cactus is a benchmark challenger only — it never replaces the
> working LiteRT/llama.cpp/Needle runtimes.
>
> DEVICE UNAVAILABLE (2026-10-10): `adb 192.168.2.100:37399` refuses
> (10061) from all environments. No measured runs are claimed. Fixture-mode
> reports prove harness shape only; timings stay `null` with
> `deviceRequired: true` until the phone is reachable.

## 1. Candidate table (pins + license/distribution + runtime/format + RAM estimate)

| # | Model (lab id) | Modality | Upstream repo / file | Revision | SHA-256 | License / distribution | Runtime / format | RAM estimate (min/rec, MiB) | Status | Catalogue tier |
|---|---|---|---|---|---|---|---|---|---|---|
| T1 | `qwen3-0.6b-dynamic-int4` — Qwen3 0.6B (keep/baseline) | text | `litert-community/Qwen3-0.6B` / `Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm` | `a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76` | `03e7da1e…5d2856` (verified, mirrors `modelProfiles.ts`) | Apache-2.0 / redistributable | `litert-lm` / `litertlm` | 1500 / 2048 | integrated-baseline | Recommended (production) + lab baseline |
| T2 | `qwen3-1.7b-dynamic-int4` — Qwen3 1.7B | text | `litert-community/Qwen3-1.7B` / `Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm` | `pending-verification` | `pending-verification` | Apache-2.0 / pending-verification (no bundle/download until verified; benchmark fixture only) | `litert-lm` / `litertlm` | 2200 / 3072 (host estimate) | integrated-pending-measurement | Advanced (unmeasured) |
| T3 | `lfm2-350m-q4_0` — LFM2 350M | text | `LiquidAI/LFM2-350M` / `LFM2-350M-Q4_0.gguf` | `pending-verification` | `pending-verification` | LFM-1.0 / benchmark-eval-only, catalogOnly (no bundling/download) | `llama-cpp` / `gguf` | 1200 / 1800 (host estimate) | integrated-pending-measurement | Advanced (unmeasured) |
| T4 | `lfm2-700m-q4_0` — LFM2 700M | text | `LiquidAI/LFM2-700M` / `LFM2-700M-Q4_0.gguf` | `pending-verification` | `pending-verification` | LFM-1.0 / benchmark-eval-only, catalogOnly | `llama-cpp` / `gguf` | 1500 / 2200 (host estimate) | integrated-pending-measurement | Advanced (unmeasured) |
| T5 | `lfm2-1.2b-q4_0` — LFM2 1.2B | text | `LiquidAI/LFM2-1.2B` / `LFM2-1.2B-Q4_0.gguf` | `pending-verification` | `pending-verification` | LFM-1.0 / benchmark-eval-only, catalogOnly | `llama-cpp` / `gguf` | 1800 / 2600 (host estimate) | integrated-pending-measurement | Advanced (unmeasured) |
| T6 | `granite-3.3-2b-instruct-q4_0` — Granite 3.3 2B Instruct | text | `ibm-granite/granite-3.3-2b-instruct` / `granite-3.3-2b-instruct-Q4_0.gguf` | `pending-verification` | `pending-verification` | Apache-2.0 / pending-verification (no bundle/download until verified) | `llama-cpp` / `gguf` | 2300 / 3200 (host estimate) | integrated-pending-measurement | Advanced (unmeasured) |
| V1 | `smolvlm2-500M-vision` — SmolVLM2 500M (baseline only) | vision | `litert-community/SmolVLM2-500M` / `SmolVLM2-500M.litertlm` | `dad030b6e56756201d670cfb4d042736a2ce3a5c` | `b808b328…60ad0` (verified, mirrors `modelProfiles.ts`) | Apache-2.0 / redistributable | `litert-lm` / `litertlm` | 1500 / 2048 | integrated-baseline | Recommended (production) + lab baseline |
| V2 | `lfm2-vl-450m-int4` — LFM2-VL 450M | vision | `LiquidAI/LFM2-VL-450M` / `LFM2-VL-450M-int4.litertlm` | `1abed04b6fe71314d8c446a1371c03d7c332266d` (evaluated litert-lm arm) | `45a02241…4797` stock (fixB `6854cd96…6033` recorded; re-measurement required) | LFM-1.0 / benchmark-eval-only, catalogOnly | `litert-lm` / `litertlm` | 1600 / 2300 (host estimate) | integrated-pending-measurement | Advanced (unmeasured) |
| V3 | `lfm2-vl-1.6b-int4` — LFM2-VL 1.6B | vision | `LiquidAI/LFM2-VL-1.6B` / `LFM2-VL-1.6B-int4.litertlm` | `pending-verification` | `pending-verification` | LFM-1.0 / benchmark-eval-only, catalogOnly | `litert-lm` / `litertlm` | 2400 / 3400 (host estimate) | integrated-pending-measurement | Advanced (unmeasured) |
| V4 | `qwen3-vl-2b-instruct-int4` — Qwen3-VL 2B Instruct | vision | `Qwen/Qwen3-VL-2B-Instruct` / `Qwen3-VL-2B-Instruct-int4.litertlm` | `pending-verification` | `pending-verification` | Apache-2.0 / pending-verification (no bundle/download until verified) | `litert-lm` / `litertlm` | 2400 / 3400 (host estimate) | integrated-pending-measurement | Advanced (unmeasured) |

Notes:

- Historical lab arms `lfm2.5-1.2b-q4_0`, `lfm2.5-vl-450m-stock`, `lfm2.5-vl-450m-fixb`
  in `modelProfiles.ts` are untouched evaluation history. The new `lfm2-*`
  lab candidates above are the benchmark-lane entries for this matrix.
- `pending-verification` is not a pin: the lab download gate blocks
  bundle/download until revision+sha are verified against upstream. Fixture
  runs need no weights.
- RAM figures are host estimates for planning only. Device measurement
  (peak PSS + thermal via DeviceProbe) lands per run below.
- Cactus challenger runtime `cactus-lab` is a separate benchmark seam
  (`apps/mobile/src/services/ai/benchmark/cactusChallenger.ts`): the same
  model can be run as LiteRT vs llama.cpp vs Cactus for comparison. It never
  registers with the orchestrator and never replaces a working runtime.

## 2. Per-model status

- `qwen3-0.6b-dynamic-int4`: integrated-baseline (keep). Production text
  baseline path unchanged.
- `qwen3-1.7b-dynamic-int4`: integrated-pending-measurement. Code support
  (catalogue + harness + fetch plan) landed; weights unverified; no device run.
- `lfm2-350m-q4_0`: integrated-pending-measurement. LFM gate enforced
  (benchmark/eval only).
- `lfm2-700m-q4_0`: integrated-pending-measurement. LFM gate enforced.
- `lfm2-1.2b-q4_0`: integrated-pending-measurement. LFM gate enforced.
- `granite-3.3-2b-instruct-q4_0`: integrated-pending-measurement.
- `smolvlm2-500M-vision`: integrated-baseline (vision baseline only).
- `lfm2-vl-450m-int4`: integrated-pending-measurement. Prior stock/fixB
  evaluation noted; on-device re-measurement in the new harness required.
- `lfm2-vl-1.6b-int4`: integrated-pending-measurement. LFM gate enforced.
- `qwen3-vl-2b-instruct-int4`: integrated-pending-measurement.

## 3. Support added per model (this lane)

- Catalogue: `apps/mobile/src/services/ai/benchmark/labCatalog.ts`
  (10 candidates, distribution gates, `getChatCapableLabModels` /
  `getVisionCapableLabModels` / `getBenchmarkCapableLabModels` capability
  selectors, `recommendedLabCatalogue()` empty by design).
- Corpus: `apps/mobile/src/services/ai/benchmark/benchmarkCorpus.ts` +
  `tools/bench/model-lab-corpus.v1.json` (`model-lab-v1`: 14 text + 6 vision
  cases; English + Bangla; Bangladesh locations/names; lost/found
  extraction; ambiguous; tool calls; refusals/privacy; loop/echo attacks;
  normal camera; documents/cards; damaged; multiple objects; poor light;
  high-res derivatives; shared 256/512 token budgets).
- Harness: `apps/mobile/src/services/ai/benchmark/benchmarkHarness.ts` +
  `tools/bench/run-model-lab-bench.mjs` (same prompts/images/budgets across
  runtimes; records load, first-token latency, tok/s, peak PSS, thermal,
  cancel latency, structured validity, hallucination/echo, Bangla score,
  vision accuracy, report-extraction score; fixture mode proves shape,
  device mode fills timings).
- Runtime challenger: `apps/mobile/src/services/ai/benchmark/cactusChallenger.ts`
  (`cactus-lab` seam, license + lab-channel gates before any native call).
- Download/fetch: `scripts/fetch-lab-models.mjs` (`--list` / `--plan` /
  `--fetch <id> --channel benchmark`; refuses production channels for LFM
  and pending pins).
- Tests: `labCatalog.test.ts`, `benchmarkCorpus.test.ts`,
  `benchmarkHarness.test.ts` (fixture outputs), `cactusChallenger.test.ts`.

## 4. UI contract (capability-driven, no per-model switches)

- Production quick picker (`ModelCatalogSheet` assistant variant) renders
  whatever the registry returns via `rolesForCatalogRecord` (chat/vision
  roles). No `if (modelId === ...)` switch exists in picker, `Help.tsx`
  gating uses `isAssistantSelectableOfflineRecord` /
  `supportsAssistantMessage` (role checks), and `AiModelsRoute` renders
  `service.registry.catalogue()` generically.
- Lab selectors follow the same contract: `getChatCapableLabModels` /
  `getVisionCapableLabModels` filter by `capabilities` + `taskRoles`. A
  synthetic future candidate test proves a new id with the same shape
  appears with no UI change.
- New lab models appear nowhere in Recommended UI. Advanced catalogue data
  exists in `labCatalog.advancedCatalogue()` with `advancedNote`
  "Unmeasured … needs phone measurement before any pick." Owner picks from
  measured data before any production wiring.

## 5. Exact on-device run procedure (when the phone is reachable)

Preconditions:

1. `adb devices` shows the phone (currently `192.168.2.100:37399`
   refuses 10061 — stop here until reachable; do not fabricate).
2. On `main`, `git pull --ff-only`, `npm run typecheck`, `npm run lint`
   green.
3. `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` present for any
   device-bound build (FindBack rule; publishable key only).

Steps (one resident engine at a time; every switch is
release-current → load-next → verify):

1. Verify pins for the candidate under test against upstream (repo + file
   + revision + sha256). Record verified values in `labCatalog.ts`
   (`pinsVerified: true`); keep LFM arms `catalogOnly`/benchmark-only.
2. Fetch weights on the lab channel only:
   `node scripts/fetch-lab-models.mjs --fetch <modelId> --channel benchmark`.
   Refusal on bundle/download for LFM/pending is expected — never bypass.
3. Install the debug APK on the phone and open On-device AI. Confirm the
   production Recommended set is still exactly Needle + SmolVLM2.
4. Fixture sanity (host, no device): `node tools/bench/run-model-lab-bench.mjs
   --out tools/bench/reports/model-lab-bench-fixture-<stamp>.json`.
   Expect 10 candidates, `deviceRequired: true`, all timings `null`.
5. On-device text lane (per text candidate): route every
   `textCases` prompt with `maxOutputTokens: 256` through each runtime
   under test (LiteRT vs llama.cpp vs `cactus-lab` where applicable).
   Record load ms, first-token ms, tok/s, peak PSS (DeviceProbe), thermal,
   cancel ms (abort mid-stream), structured validity, echo/hallucination,
   Bangla score (bn cases), extraction score.
6. On-device vision lane (per vision candidate): route every
   `visionCases` image+instruction with `maxOutputTokens: 512` through the
   canonical media derivative pipeline (never raw camera bytes). Record the
   same timings plus vision accuracy per category (normal, document/card,
   damaged, multi-object, poor light, high-res derivative).
7. Refusal/privacy + loop probes must be scored per run: PII echoes and
   runaway repetitions are failures regardless of fluency.
8. Write the measured report beside the fixture report:
   `tools/bench/reports/model-lab-bench-device-<stamp>.json` (same shape,
   timings filled, `deviceRequired: false` for measured cases only).
9. Update this matrix: move only measured candidates to
   `measured-<date>` with a link to the device report. Do not move any
   candidate to Recommended here — the owner hand-picks from measured data
   in a separate decision.
10. Run `npm run lint`, `npm run typecheck -w apps/mobile`,
    `npx vitest run src/services/ai/benchmark/`, and
    `node scripts/ai-release-gate.mjs` (must stay PASS: production
    Recommended, license gates, and promotion policy untouched).

Evidence layout: `tools/bench/reports/model-lab-bench-*.json` +
`test-evidence/model-lab/<run>/` (adb log, probe records, timing JSON).

## 6. What still needs the physical phone

- All load / first-token / tok/s / peak PSS / thermal / cancel-latency
  numbers for the 8 new candidates (currently `null`, `deviceRequired`).
- Vision accuracy on real camera photos, documents/cards, damaged items,
  multi-object scenes, poor light, and high-res derivatives.
- Bangla + extraction quality per runtime (fixture recall proves scorer
  shape only).
- Same-model-vs-runtime comparison (LiteRT vs llama.cpp vs Cactus) with
  measured evidence before any runtime decision.
- Owner hand-pick from measured data before any production promotion.
