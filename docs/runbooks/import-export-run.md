# Runbook X3 — Import/export device-day run (gated)

The gate is the order: **small safe fixture first, real Qwen package only
after the fixture passes.** The real-package step must refuse to run until
the fixture gate below passes. Evidence lands in
`test-evidence/import-export/`.

`scripts/devprep/fixture-verify.mjs` was retired in commit `34b6ae7`;
the gate is reproduced with shell tools — no replacement harness exists.

## Step 0. Fixture pass (host-runnable, do this first)

```sh
run=test-evidence/import-export/fixture
mkdir -p "$run" && cd "$run"
head -c 65536 /dev/urandom > photo-thumb.bin
head -c 65536 /dev/urandom > weights-note.bin
printf '{"report":"fixture"}' > report-fields.json
sha256sum photo-thumb.bin report-fields.json weights-note.bin > checksums.json
sha256sum -c checksums.json
printf '{"passedAt":"%s"}' "$(date -u +%FT%TZ)" > fixture-pass.json
```

Expected: three 64 KiB synthetic payloads (`photo-thumb.bin`,
`report-fields.json`, `weights-note.bin` — clearly not weights),
`checksums.json` verifies, and `fixture-pass.json` is written with
`passedAt`. If `sha256sum -c` fails, stop: debug the payloads, never
skip to the real package.

## Step 1. Fixture import/export in-app (device)

Using the Offline AI per-model Import/Export buttons with the fixture
payload shape: export packages the files, import re-verifies hashes.
Evidence: `fixture-import.json`, `fixture-export.json`
(`{entryId, files, bytes, sha256-ok}`).

## Step 2. Gate check (device day, before touching the real package)

```sh
cd test-evidence/import-export/fixture
sha256sum -c checksums.json && test -f fixture-pass.json
```

Non-zero exit = BLOCKED. Re-run Step 0/1; do not proceed.

## Step 3. Real Qwen package only (after the gate opens)

Build the real package from the pinned local weights only
(`scripts/build-fbmodel-local.py` — local cache, no network, no download),
then import/export the `qwen3-0.6b-litert-dynamic-int4` package and verify
installed 344671744 B / sha `03e7da1e…5d2856` unchanged inside.
Evidence: `qwen-package-import.json`, `qwen-package-export.json`.

Never commit weights: outputs default outside git (`/tmp/findback-modeldist`
for packages, `test-evidence/` for records — both ignored).
