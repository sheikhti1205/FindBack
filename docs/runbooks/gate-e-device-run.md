# Runbook X1 — Gate-E device-day run (CreateReport integration set)

Device-day replay of the prepared pass. Everything automatable without a
phone is already dry-run by `scripts/devprep/gate-e-run.mjs`; this runbook
is the human checklist for the device-only steps.

## 0. Preconditions (host)

- `node scripts/devprep/gate-e-run.mjs --dry-run` passes (manifest in
  `test-evidence/devprep/gate-e/<stamp>/manifest.json`).
- `node scripts/devprep/collect-build-info.mjs` written
  (`test-evidence/devprep/shared/build-info.json`): git SHA + versionName.
- Debug APK installed from the recorded SHA; record versionCode from the
  About screen (native `versionCode`, `build.gradle` `gitVersionCode()` rule)
  into `test-evidence/devprep/gate-e/<run>/build-capture.json`.

## 1. camera → Analyze

1. Report tab → camera capture a real photo.
2. **Analyze photo** → **Generate suggestions (local VLM, GPU preferred)**.
3. Start a stopwatch at tap; stop when suggestions land in title/description.
4. Evidence: `camera-analyze-timing.json` (`{startedAt, durationMs,
   backend: gpu|cpu, cpuNoticeShown}`), `screenshot-ca01..NN.png`.
5. Expected: GPU backend; if GPU init fails and CPU compatibility mode is
   allowed, analysis runs on CPU with the explicit on-screen notice — never
   silent (`vlmPlugin.ts` CPU-notice path).

## 2. gallery → Analyze

Same as §1 with a gallery attach. Evidence: `gallery-analyze-timing.json`,
`screenshot-ga01..NN.png`. Note any backend difference vs §1.

## 3. Publish

Publish → open the post → **Possible Matches** shows ≤3 open opposite-type
reports (on-device text embeddings, cosine similarity; photo never leaves
the device). Evidence: `publish-timing.json`, `screenshot-publish.png`.

## 4. Subscript-error repro

Reproduce the Gate-E subscript error; paste the EXACT message (on-screen
text + matching `logcat -v threadtime` lines) into `subscript-error.txt`
with the tap sequence. Do not paraphrase — exact text only.

## 5. Diagnostics export + logcat

- Settings → Diagnostics → export (`exportDiagJson`, redacted at record
  time) → `diag-export.json`; Splash boot diagnostics → `screenshot-diag.png`.
- Full pass logcat: `adb -s <serial> logcat -d -v threadtime` →
  `logcat-gate-e.txt`.

## 6. Close-out

Re-run `gate-e-run.mjs --device --serial=<serial>` to flip step statuses;
attach the run dir listing to the status report. Timing rows from §§1–3 are
the Gate-E performance evidence.
