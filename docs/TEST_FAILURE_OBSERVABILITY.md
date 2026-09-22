# Mobile test-failure observability

Intermittent mobile failures have recurred without preserving which test
failed. This note documents the repeat runner that captures the next failure
with its full identity. It changes no tests, adds no retries, sleeps, or
timeout adjustments.

## Command

```
node scripts/repeat-mobile-tests.mjs [--runs=20] [--out=test-evidence/mobile-repeat]
```

Runs the full mobile suite (`npm test -w @findback/mobile`) up to `--runs`
times (default 20) and stops at the first failure with identity. Each run is a
single attempt with reporter output only; nothing about scheduling, timeouts,
or test selection is altered.

## Artifacts (local only, gitignored under `test-evidence/`)

- `run-NN.log` — raw combined stdout/stderr of run N.
- `run-NN.vitest.json` — machine-readable vitest JSON report for run N.
- `run-NN.json` — run metadata (command, start time, duration, exit code,
  parsed failures) plus environment.
- `failure-identity.json` — written on the first failing run: failing file(s),
  test name(s), seed/config defaults, worker setup, stderr tail, duration,
  environment, and pointers to the per-run files. The runner exits 1.
- `summary.json` — written when every run passes: per-run metadata and the
  conclusion that the intermittent did not reproduce in this set. Exit 0.

## Environment captured per run

Node version, platform/arch, CPU count, `CI`/`NODE_ENV` values, git SHA and
branch, vitest version, and the worker/seed defaults in effect. No secrets or
key material are recorded.

## Evidence is never committed

`test-evidence/` is gitignored. Reports on the intermittent reference the
local bundle by path and quote the identity fields; the raw logs stay local.
