# Runbook X2 — Native model device-day run (six-model acceptance matrix)

Ordered pass. One generative model resident at a time (G7): every switch is
release-current → load-next → verify. Evidence lands in
`test-evidence/native-models/<run>/`.

> **STATUS: NOT RUN.** Every result cell in §2 and every row in §6 is a blank
> template. Fill a cell only from an observed pass on the recorded APK and
> device serial; never fill one from source reading, CI, another machine, or
> another worker's log. `test-evidence/` is gitignored — these are run records,
> never production data.

## 0. Asset sources (exact; never re-resolve, never substitute)

Two recommended models are consumed as GitHub release `.fbmodel` packages. The
four experimental candidates are consumed as pinned Hugging Face raw
`.litertlm` files — **not** the matching `FindBack-Models` release assets. The
release publishes all six assets, but the app downloads only the two `.fbmodel`
files from GitHub and the four raw files from HF (audit 04; catalogue
`pinnedRawSource`; native `PinnedModelSources.kt`). Tell testers this: a
release asset existing does not mean the app fetches it.

Release: `https://github.com/sheikhti1205/FindBack-Models/releases/tag/models-2026-09-22-v1`
— observed 2026-09-25 via GitHub API as published `2026-09-24T16:27:16Z`,
draft=false, prerelease=false, all six assets `uploaded` with the byte counts
below. Re-check on run day: this tag was originally authored unpublished (W
audit `20260922T140000-w-truth2-status-01.md` B1), so if it is missing, draft
or an asset is absent, Download fails closed with an honest
`DOWNLOAD_FAILED` / `NOT_PUBLISHED` — record that outcome in steps 1–2 and
never treat it as success.

### 0a. GitHub release `.fbmodel` packages (recommended 2)

| # | Catalogue id | Asset | Download bytes | Download sha256 (package pin) | Installed bytes | Installed sha256 (weights pin) | rev |
| --- | --- | --- | ---: | --- | ---: | --- | --- |
| 1 | `smolvlm2-500m-litert-int4` | `smolvlm2-500m-litert-int4.fbmodel` | 360823865 | `6504b9e8972b40bd16f87b8e3bf680b2091b2f135cc23189cc0f8c86a3f1b137` | 360822960 | `b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0` | `dad030b6e56756201d670cfb4d042736a2ce3a5c` |
| 2 | `qwen3-0.6b-litert-dynamic-int4` | `qwen3-0.6b-litert-dynamic-int4.fbmodel` | 344672709 | `83109b67d59e349e7fdbd178a4742030656813edd9442c8713ca71b38e4a1efb` | 344671744 | `03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856` | `a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76` |

The download pin covers the `.fbmodel` container; the installed pin covers the
extracted weights. Verify the one that applies to the byte stream you are
checking — never compare package bytes against an installed-weights hash.

### 0b. Hugging Face pinned raw `.litertlm` (experimental 4)

URL pattern: `https://huggingface.co/<repo>/resolve/<40-hex rev>/<file>`
(native `PinnedModelSources.kt` builder). Download bytes = installed bytes and
the single sha below is both the transfer and the installed-weights pin.

| # | Catalogue id | Repo | rev | File | Bytes | sha256 |
| --- | --- | --- | --- | --- | ---: | --- |
| 3 | `qwen3-0.6b-litert-mixed-int4` | `litert-community/Qwen3-0.6B` | `a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76` | `qwen3_0_6b_mixed_int4.litertlm` | 497516544 | `7900eb4e7362d88c58782c6f9999bb7a129e03544aa98b8f338ea0cc5d8c22c1` |
| 4 | `qwen3-0.6b-litert-int8` | `litert-community/Qwen3-0.6B` | `a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76` | `Qwen3-0.6B.litertlm` | 614236160 | `555579ff2f4fd13379abe69c1c3ab5200f7338bc92471557f1d6614a6e5ab0b4` |
| 5 | `lfm2.5-1.2b-instruct-litert-int4-gpu` | `litert-community/LFM2.5-1.2B-Instruct` | `4ef1641b562b70ffca66ce4fee7bef4446b374b6` | `LFM2.5-1.2B-Instruct_int4_gpu.litertlm` | 736220768 | `97e6a9700208f59fce2ceb993cd6c18ea77ada8c2a940f68332004f38a404671` |
| 6 | `lfm2.5-vl-450m` | `litert-community/LFM2.5-VL-450M` | `be196f4fa88b2dfba8cdbbbff07b641df794f977` | `LFM2.5-VL-450M_int4_fixB.litertlm` | 406817104 | `6854cd9677a34e680070b60076793e49aeb3224de7cb4101076b261cb9bf6033` |

## 1. Scope and roles

| # | Model | Category | Route |
| --- | --- | --- | --- |
| 1 | SmolVLM2 500M | recommended | dedicated image lifecycle |
| 2 | Qwen3 0.6B dynamic INT4 | recommended | dedicated text lifecycle |
| 3 | Qwen3 0.6B mixed INT4 | experimental | candidate host (text) |
| 4 | Qwen3 0.6B INT8 | experimental | candidate host (text) |
| 5 | LFM2.5 1.2B INT4 GPU | experimental | candidate host (text) |
| 6 | LFM2.5 VL 450M fixB | experimental | candidate host (image) |

Roster and licences are catalogue facts, not claims of device success: rows
3–6 carry `verificationStatus` `EXPERIMENTAL` or `SUPPORTED_UNVERIFIED` and
keep their experimental/licence notices. A successful self-test never promotes
an experiment, and a failed experiment is never silently replaced by a
different model.

## 2. Six-model manual acceptance matrix — ALL CELLS NOT RUN

Columns follow audit 06 §C. Enter `PASS <evidence-file>` / `FAIL <detail>` /
`SKIP <reason>` only from an observed run.

| Model | Download | Hash | Verify | Use | Inference | Restart / cancel / swap | Backend / memory / result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SmolVLM2 500M (release `.fbmodel`) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Qwen3 dynamic INT4 (release `.fbmodel`) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Qwen3 mixed INT4 (HF pinned raw) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Qwen3 INT8 (HF pinned raw) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| LFM2.5 1.2B INT4 GPU (HF pinned raw) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| LFM2.5 VL 450M fixB (HF pinned raw) | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

Column expectations:

- **Download** — `NOT_INSTALLED → DOWNLOADING → INSTALLED_UNVERIFIED`, bytes
  matching §0; never report `READY` when only package bytes exist.
- **Hash** — observed digest equals the §0 pin for that stream.
- **Verify** — native `verifyCandidateModel` / dedicated self-test: installed
  byte re-hash plus a real role-specific generation, not a file-exists check.
- **Use** — activation succeeds only on observed readiness; anything already
  resident is evicted first (single-resident, G7).
- **Inference** — real output from the §5 suites, with model id and elapsed
  time recorded per prompt.
- **Restart / cancel / swap** — process restart lazy-reloads honestly; cancel
  emits exactly one terminal and never unlocks the mutex early; A→B and
  A→recommended→candidate swaps leak no handles.
- **Backend / memory / result** — record the reported `backend` string
  verbatim **and** the delegate actually observed (logcat/host). Candidate
  results report `backend:"unknown"` on current source — never infer GPU from
  the wire value, and never restate an estimate as a measurement. Record
  free/peak RAM before and after.

## 3. Ordered steps

Precondition: §0 release check recorded first.

1. **SmolVLM2 download + verify.** Offline AI → Download `smolvlm2-500m`.
   Expected states: `NOT_INSTALLED` → `DOWNLOADING` → `INSTALLED_UNVERIFIED`
   → `READY_GPU` after self-test. Evidence: `01-smol-download.json`
   (states + bytes + sha match against §0a).
2. **Qwen download + verify.** Same flow for the Qwen entry; verify
   installed 344671744 B and sha `03e7da1e…5d2856`. Evidence:
   `02-qwen-download.json`.
3. **Activate Qwen (text).** Set Qwen active. Expected: text queries route to
   Qwen; Qwen output strips the `[thought]…[/thought]` envelope before
   parsing/scoring (never surface reasoning). Evidence:
   `03-qwen-active.json` (active-model id + raw vs stripped sample).
4. **Assistant question.** Ask a help question via the assistant path.
   Expected: grounded answer or deterministic fallback when Qwen is not
   native-ready — never a silent fake "active" status. Evidence:
   `04-assistant-answer.json`.
5. **Loop / recovery case.** Prompt a known loop probe (e.g. repeated-phrase
   bait). Expected: `LOOP_DETECTED` fail-closed after retryLimit 1, surfaced
   through the recovery path. Evidence: `05-loop-recovery.json`
   (errorClass + diagnostic).
6. **Switch to SmolVLM2 (image).** Release Qwen → load SmolVLM2 → image
   analysis on a real photo. Expected: single-JSON-object attempt behind
   schema validation + echo rejection; record valid vs loop vs invented per
   the evaluation vocabulary. Evidence: `06-smol-image.json`.
7. **Switch back to Qwen.** Release SmolVLM2 → reload Qwen → re-ask the §4
   question. Expected: same routing as §3/§4, confirming the switch is
   symmetric. Evidence: `07-switchback.json`.
8. **Candidate download (rows 3–6).** For each candidate entry in §0b:
   Offline AI → candidate row → Download. Confirm the fetched bytes come from
   the pinned HF URL and match §0b — **not** the same-named release asset.
   Repeat once per candidate so each has its own record. Evidence:
   `08-candidate-<id>-download.json`.
9. **Candidate Use (verify + init).** Tap `Use`. Expected: installed bytes are
   re-hashed, a real role probe runs, and any other resident generative engine
   is evicted first (single-resident). `Use` is offered only when source-native
   state maps to READY. Evidence: `09-candidate-<id>-use.json`.
10. **Candidate inference.** Run the §5 image suite (row 6) or text suite
    (rows 3–5). Expected: nonempty, grounded output; reasoning/thinking
    envelope never surfaced. Record prompt/result pairs with model id and
    elapsed time. Evidence: `10-candidate-<id>-inference.json`.
11. **Candidate restart / cancel / swap.** Per candidate: kill and relaunch
    (honest lazy reload, no fictional `residentModelId`), cancel mid-run
    (exactly one terminal; no indefinite spinner), then swap A→B and
    A→recommended→candidate. Evidence: `11-candidate-<id>-lifecycle.json`.

Notes for steps 10–11, so nothing is assumed:

- Candidate inference emits `candidateInferenceState` phases
  (`LOADING_MODEL` / `PREPARING_IMAGE` / `RUNNING` / `POSTPROCESSING`, plus
  phaseless terminals) on current native source; the web layer does not consume
  that listener yet. If the APK under test predates it or the UI shows no
  phase, record that as observed — do not claim phases rendered.
- Candidate `backend` is `unknown` on the wire; the real delegate comes from
  logcat/host observation only.

## 4. Download abuse checklist (shared, all rows)

Run at least once against one release `.fbmodel` row and one HF raw row:
Wi-Fi start, pause, resume, switch to cellular under an explicit rule, cancel
then fresh start, app background/foreground, low storage, device reboot
mid-transfer, 4xx/5xx response, and a deliberately corrupted payload (bad
hash). Verify the exact cache/final file state after each failure; a corrupted
prefix must be discarded, never reported installed.

Evidence: `12-download-abuse.json` — one entry per scenario with expected /
actual / result. **NOT RUN.**

## 5. Prompt suites (shared)

- **Image suite:** at least one single obvious object, two distinct objects,
  low light, rotated photo, cluttered background, unusual orientation, and a
  misleading/non-object image. Inspect factual grounding, not just nonempty
  text. Protect personal images.
- **Text suite:** 15–20 fixed questions covering app FAQ, Search vs Report
  intent, out-of-domain, incomplete context, valid and invalid structured
  actions, repetition, `<think>`/chain-of-thought leakage, unsupported
  statements, and exact route handoff.
- Save every prompt/result pair with model id and elapsed time. Evidence:
  `13-prompt-suites/`. **NOT RUN.**

## 6. Negative cases N01–N10 — ALL NOT RUN

Host JVM coverage exists for some of these (native worker log reports
`CandidateRuntimeControllerTest` 17, `GenerativeResidencyArbiterTest` 15,
`CandidateStatusTruthTest` 6, `CandidatePhaseEventTest` 5, full Kotlin
329/329 with fakes). Those are **host** results only: the device column stays
NOT RUN until observed on the phone.

| ID | Case | Expected | Device result |
| --- | --- | --- | --- |
| N01 | Release while a run is in flight | No handle close until `run` completes; no use-after-close, no double release; `LocalVlmPlugin.release()` defers too | NOT RUN |
| N02 | Probe/verify against an already active candidate | At most one resident generative engine; correct status if the probe fails | NOT RUN |
| N03 | Fail initialization after allocation | Exactly the temporary handle is closed; state reports not resident | NOT RUN |
| N04 | Restart with a persisted candidate selection | Status distinguishes selected/file-verified from resident/initialized; no fictional `residentModelId` | NOT RUN |
| N05 | Stale/corrupt candidate bytes (ephemeral test model only) | Image readiness not `READY`; inference rejects `HASH_MISMATCH`; UI offers a recoverable action | NOT RUN |
| N06 | Source/pin protection | Unknown URL denied; wrong revision/size/hash blocked; no unexpected fallback; integrity recheck before use | NOT RUN |
| N07 | Async cancellation | Cancel then release/switch → exactly one terminal event; mutex not unlocked before native work finishes; no stale spinner | NOT RUN |
| N08 | Role routing | Text candidate never enters image analysis; image candidate never accepted as text; qualified Qwen/Smol resume after candidate release | NOT RUN |
| N09 | Bad output | Blank text / self-test failure never reported as verified or active | NOT RUN |
| N10 | Multi-model swap | A→B→recommended→candidate with no leaked handles and no localStorage/native pointer split | NOT RUN |

Evidence: `14-negative-N01..N10.json` (one file or one object per id, each
with expected / actual / result). **NOT RUN.**

## 7. Evidence package

Per run, under `test-evidence/native-models/<run>/`:

- `build-capture.json` — APK path + SHA-256, baked source SHA, versionCode,
  device serial, OS/build, chipset, total and available RAM, selected model
  id, network and battery/thermal condition.
- The numbered step files from §3, §4, §5 and §6.
- `adb logcat -d -v threadtime` captured during each verify/use/generate,
  filtered for sensitive data before sharing.
- `matrix.tsv` — one line per §2 cell: model, column, expected, actual,
  result. Leave rows absent rather than inventing them.

Templates ship empty and marked **NOT RUN**. Redact tokens, email addresses,
locations and photo contents. Never write to production records.

## Forbidden

Cross-role routing (image→Qwen, text→SmolVLM) and two resident engines.
Substituting a model, URL, revision or hash that §0 does not list. Marking a
matrix or N-row cell anything other than NOT RUN when it was not observed on
the recorded APK. Any deviation fails the run.
