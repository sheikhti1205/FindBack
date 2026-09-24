# Runbook X1 — Gate-E device-day run (CreateReport integration set)

Device-day replay of the prepared pass. The retired
`scripts/devprep/gate-e-run.mjs` dry-run no longer exists (removed in
`34b6ae7`); this runbook is the human checklist for the device steps,
with the host preconditions in §0 using currently supported commands.

## 0. Preconditions (host)

The `scripts/devprep/` host harnesses (`gate-e-run.mjs`,
`collect-build-info.mjs`) were retired in commit `34b6ae7` — there is no
`--dry-run` command anymore. Run the supported host checks instead:

- `npm run typecheck` passes (repo root).
- `npm test -w @findback/mobile` passes (repo root).
- Record the build identity manually into
  `test-evidence/gate-e/<run>/build-capture.json`: `git rev-parse HEAD`
  (git SHA), `node -p "require('./apps/mobile/package.json').version"`
  (versionName), and the native `versionCode` from the About screen
  (`build.gradle` `gitVersionCode()` rule).
- Debug APK installed from the recorded SHA.

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

Update the step statuses in the run dir manually (the retired
`gate-e-run.mjs --device` flip no longer exists); attach the run dir
listing to the status report. Timing rows from §§1–3 are the Gate-E
performance evidence.
