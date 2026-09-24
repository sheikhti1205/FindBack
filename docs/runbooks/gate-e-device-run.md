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

## 6. Editor checklist (E01–E25)

Manual editor set from audit 06 §A. **STATUS: NOT RUN.** Every result below is
a blank template; fill it only from an observed run on the recorded APK/serial
and browser build. jsdom/host suites (editor log reports the mobile suite at
1063 tests plus a static DOM proof PNG) prove structure only — they cannot
prove typography, selection ranges or touch behaviour, so they never satisfy a
row here.

Run each row in **both** a browser (visual screenshot / regression) and the
Android WebView. Include a screenshot of Body/H1/H2/H3 in editing and after
publication for matched input. Keep results in
`test-evidence/gate-e/<run>/editor-E01..E25.tsv` (model, row, expected,
actual, result) — leave a row out rather than invent it.

| ID | Steps | Pass condition | Result |
| --- | --- | --- | --- |
| E01 | Type a fresh description | No lag, immediate draft preservation | NOT RUN |
| E02 | Select a single word and Bold | Only selected word visibly bold; toolbar clearly active | NOT RUN |
| E03 | Select a single word and Italic | Same, visibly italic | NOT RUN |
| E04 | Select word, apply Bold then Italic, save/reopen | Both survive in editor and published post | NOT RUN |
| E05 | Select phrase via Android long-press, tap Bold | Original range preserved across toolbar focus | NOT RUN |
| E06 | Select word A, deliberately tap caret at B, then Bold | A not accidentally changed; future input at B bold as intended | NOT RUN |
| E07 | Repeat E05/E06 for Italic and Link | No stale-range actions | NOT RUN |
| E08 | Choose Body/H1/H2/H3 from popup | Correct document node, visible hierarchy, selected row | NOT RUN |
| E09 | Rechoose currently selected H2 | Stays H2; choosing Body removes heading | NOT RUN |
| E10 | Convert block to bullet list | Visible bullets/indent in editor; saved post preserves list | NOT RUN |
| E11 | Convert block to numbered list | Visible numbers/indent and correct sequence | NOT RUN |
| E12 | Multiple paragraphs and list item edits | No lost text, correct boundaries/ordering | NOT RUN |
| E13 | Apply/remove Quote | Clearly visible quotation treatment; Markdown roundtrip | NOT RUN |
| E14 | Add link to selection | Sheet shows correct text; safe URL gives visible underlined link | NOT RUN |
| E15 | Tap existing link | Edit/remove options; no surprise instant destructive action | NOT RUN |
| E16 | Unsafe `javascript:`/`data:` links | Rejected; display text remains harmless | NOT RUN |
| E17 | Clear all formatting | Correct scope and informative label; undo restores | NOT RUN |
| E18 | Undo then redo heading/list/link | No lost data or incorrect active control | NOT RUN |
| E19 | Draft reload after navigation/restart | Same content and formatting; selection cache reset | NOT RUN |
| E20 | Fast tap Publish after final IME keystroke | Final character included; no stale prop value | NOT RUN |
| E21 | Near 3,000 characters with links/formatting | Counter and submit use the documented compatible limit | NOT RUN |
| E22 | Small phone width, keyboard open, popup near edge | Popup visible, not clipped; Back/Escape dismiss correctly | NOT RUN |
| E23 | Light, dark and high-contrast settings | Distinguishable heading, list, quote, link, active state | NOT RUN |
| E24 | Screen reader / keyboard traverse toolbar and popup | Names, expanded/selected, focus restore and escape work | NOT RUN |
| E25 | Paste rich text/raw HTML and publish | Supported marks preserved; scripts inert, safe renderer | NOT RUN |

Cross-checks: typography and selection rows (E02–E13, E17, E18, E22, E23) must
not be closed from host assertions alone; security rows (E16, E25) must record
the exact rejected input and the rendered output; E19/E20 need a process
restart and an IME-timed capture respectively.

## 7. Close-out

Update the step statuses in the run dir manually (the retired
`gate-e-run.mjs --device` flip no longer exists); attach the run dir
listing to the status report. Timing rows from §§1–3 are the Gate-E
performance evidence. §6 stays NOT RUN until its own device/browser
observations exist.
