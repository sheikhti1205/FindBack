# Model-lab static benchmark infrastructure (FBX-032)

Lab lane, never production. Infrastructure ONLY — no promotion, no measurements, no claims.

## Status

- `BENCHMARK_INFRASTRUCTURE_READY`
- `MEASUREMENTS_DEFERRED_OWNER_DEVICE` (no reachable phone; every absent number stays `null` with reason `device-required`)
- `PROMOTION_DEFERRED_OWNER_SELECTION` (no candidate is Recommended; nothing wires into the registry, router, picker, profiles, or descriptors)

## Files (all NEW, under `apps/mobile/src/services/ai/testing/`)

| File | Provides |
| --- | --- |
| `benchmarkCandidateSchema.ts` | Exact candidate metadata schema: `revision`, `sha256`, `artifactBytes`, `license`, `redistribution`, runtime/format, task roles, prompt template, token budget, thinking mode; `measured: false` by type; 10 UNMEASURED entries (Qwen3 0.6B/1.7B, LFM2 350M/700M/1.2B, LFM2-VL 450M/1.6B, Qwen3-VL 2B, MiniCPM 2B pending validation, SmolVLM2 500M baseline entry) |
| `benchmarkDownloadGate.ts` | Fail-closed download gate: blocks weight channels on unverified pins, eval-only licenses, and unconfirmed byte sizes; lab channels allow fixture-only runs (no artifact fetch); never fetches |
| `benchmarkCorpusDef.ts` | Fixed benchmark corpus `model-lab-bench-v1`: 12 text cases (help, report/search extraction, category, intent, bn-en mixed, malformed, long-bounded, repetition trap) + 10 vision cases (ordinary, clutter, text, brand, uncertain, low-light, multiple, Bangla, privacy, high-res derivative); identical lane budgets; repo-local image refs |
| `benchmarkResourceHooks.ts` | RAM/PSS + thermal capture hook interfaces; null hooks report `device-required` sentinels |
| `benchmarkRunner.ts` | Per-case runner with timeout (`BenchmarkTimeoutError`) and cancel (`BenchmarkCancelledError`); records hook samples; invents no timings |
| `benchmarkResultLogger.ts` | Structured-result logger: immutable JSON-lines records + round-trip validation |
| `benchmarkScoreCalculator.ts` | Deterministic pure scorer: keyword recall, structured validity, echo flag, lane means |
| `benchmarkReport.ts` | Report generator + comparison format (`findback-lab-comparison-v1`, Markdown renderer); rows read UNMEASURED until phone evidence lands |
| `benchmarkCactusIsolation.ts` | Cactus challenger isolation: lab channels only, gate-first, throws before any native call |

Tests: `benchmarkCandidateSchema.test.ts` (schema validation), `benchmarkDownloadGate.test.ts` (gate),
`benchmarkRunner.test.ts` (timeout/cancel), `benchmarkScoreCalculator.test.ts` (determinism),
`benchmarkIsolation.test.ts` (lab never touches orchestrator/router/picker — asserts it).

## Non-promotion statement

This lane promotes nothing: candidates are metadata-only data entries, the download gate blocks every
weight channel today (unverified pins / eval-only licenses / unconfirmed byte sizes), the comparison
format marks every row UNMEASURED, and owner hand-pick from phone-measured data plus a separate
production commit remain the only path to production.

## Gates

- `npx tsc --noEmit -p apps/mobile/tsconfig.json` — PASS
- `npx eslint` on touched files — PASS
- `npx vitest run src/services/ai/testing/benchmark` — PASS (see session heartbeat for counts)
- `git diff --check` — PASS
