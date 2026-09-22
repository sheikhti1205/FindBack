# Runbook X3 — Import/export device-day run (gated)

The gate is the order: **small safe fixture first, real Qwen package only
after the fixture passes.** The real-package step must refuse to run until
`fixture-verify.mjs gate --real` exits 0. Evidence lands in
`test-evidence/devprep/import-export/`.

## Step 0. Fixture pass (host-runnable, do this first)

```sh
node scripts/devprep/fixture-verify.mjs generate
node scripts/devprep/fixture-verify.mjs verify
node scripts/devprep/fixture-verify.mjs gate --real
```

Expected: three 64 KiB synthetic payloads (`photo-thumb.bin`,
`report-fields.json`, `weights-note.bin` — clearly not weights),
`checksums.json` + `manifest.json` agree, sha256 chain verifies, and
`fixture-pass.json` is written with `passedAt`. If `verify` fails, stop:
debug the harness, never skip to the real package.

## Step 1. Fixture import/export in-app (device)

Using the Offline AI per-model Import/Export buttons with the fixture
payload shape: export packages the files, import re-verifies hashes.
Evidence: `fixture-import.json`, `fixture-export.json`
(`{entryId, files, bytes, sha256-ok}`).

## Step 2. Gate check (device day, before touching the real package)

```sh
node scripts/devprep/fixture-verify.mjs gate --real
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
