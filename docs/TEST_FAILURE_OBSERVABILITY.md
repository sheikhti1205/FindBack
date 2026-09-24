# Mobile test-failure observability

Intermittent mobile failures have recurred without preserving which test
failed. This note documents the repeat runner that captures the next failure
with its full identity. It changes no tests, adds no retries, sleeps, or
timeout adjustments.

## Command

`scripts/repeat-mobile-tests.mjs` was retired in commit `34b6ae7` with no
replacement harness. The supported equivalent is a plain shell loop that
captures the next failure with its full identity:

```sh
mkdir -p test-evidence/mobile-repeat
for i in $(seq 1 20); do
  npm test -w @findback/mobile > "test-evidence/mobile-repeat/run-$i.log" 2>&1 \
    || { echo "first failure at run $i — see run-$i.log"; break; }
done
```

Each run is a single full-suite attempt with default scheduling, timeouts
and test selection; the loop stops at the first failing run. Triage from
the failing log tail: failing file(s), test name(s), seed/worker setup,
stderr tail, duration and environment (`node --version`,
`git rev-parse HEAD`, vitest version from the log header).

## Artifacts (local only, gitignored under `test-evidence/`)

- `run-NN.log` — raw combined stdout/stderr of run N. Quote the identity
  fields from the first failing log in the report; the raw logs stay local.

## Environment captured per run

Node version, platform/arch, CPU count, `CI`/`NODE_ENV` values, git SHA and
branch, vitest version, and the worker/seed defaults in effect. No secrets or
key material are recorded.

## Evidence is never committed

`test-evidence/` is gitignored. Reports on the intermittent reference the
local bundle by path and quote the identity fields; the raw logs stay local.
