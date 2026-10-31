# Gate-E — Civi 3 application-integration acceptance

**Status: DEVICE_REQUIRED / NOT EXECUTED.** This is a prepared device-day matrix,
not evidence of a passing Civi 3 run. The v0.3.0-beta.1 owner waiver is historical
and does not validate this integration wave. Run only when device work is authorized.

## Current paths and limits

- Startup → `initializeApplicationAi` → shared `ApplicationAiService` →
  `bootProductionAi` manager/orchestrator. Startup rehashes installed pins, but
  does not download, load inference weights, or benchmark automatically.
- Settings → **AI & models → On-device AI** (`/settings/ai/models`, alias `/ai-models`) owns real native download controls.
  Installed Needle and SmolVLM2 appear in the Help model picker without BYOK keys.
- Needle: structured item-detail extraction and explicitly selected Possible
  Matches challenger; USE stays the default. Matching selection lasts this session.
- SmolVLM2: Help approved-image description, CPU default. **Measure CPU / Measure
  GPU** run `smol-color-plate-v1` (red and blue generated PNGs, greedy sampling,
  24-token cap). Both arms use the CPU language decoder; only the vision backend
  changes. Counters are real LiteRT `BenchmarkInfo`, not word/chunk estimates.
  **2026-10-25:** the consumer benchmark screen was deleted (owner: no CPU/GPU
  vocabulary on consumer surfaces). Until the background self-check ships,
  exercise both arms through `service.measure('cpu'|'gpu')` from a device
  harness; there is no in-app button for it.
- Fresh passing records can select a backend in this session. GPU init failure
  revokes its record, announces an explicit CPU retry, and never routes to cloud.
- **Inspect hardware** discovers NNAPI/Vulkan/OpenCL; discovery is not proof that
  those APIs execute Smol or Needle. There is no NNAPI timing arm. Its only UI
  entry point was the deleted Advanced screen; use `service.facts()` from a
  device harness.
- Report → Analyze photo is the consented SmolVLM2 local-first path (on-device
  default with OpenRouter cloud fallback). Do not use
  the retired GPU-preferred `vlmPlugin.ts` flow or retired `scripts/devprep` harnesses.
- The web build must refuse native inference/downloads. LFM/llama.cpp are lab-only.

## Host preconditions

Run from the repo root, recording results and the working-tree identity:

```bash
git rev-parse HEAD
git status --short
npm run lint
npm run typecheck
npm test
node --test scripts/ai-release-gate.test.mjs
node scripts/ai-release-gate.mjs
# From apps/mobile/android:
./gradlew :app:testDebugUnitTest --console=plain
```

Build only with the canonical ignored root `.env` loaded: derive and assert
nonempty `VITE_SUPABASE_URL=$SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY=$SUPABASE_PUBLISHABLE_KEY` before `npm run apk`.
Use only a publishable key. Supply `VITE_PUBLIC_SHARE_ORIGIN` and the release
configuration required by `scripts/build-apk.mjs`. Require post-build
`scripts/check-release-config.mjs` bundle/APK proof before installing or handing
over the artifact. Never install an artifact with a missing server URL.

Record git SHA **and dirty diff if any**, APK SHA-256, app versionName/versionCode,
Android OS/security-patch version, device serial, SoC/GPU/RAM, model revision/SHA,
probe version and corpus version. Select the target with `adb -s <serial>`.
Use a dedicated test account/reports; publishing and clearing app data are explicit
device-day actions, not host checks.

## Acceptance matrix

Every row starts **NOT EXECUTED**. Record PASS/FAIL/BLOCKED, exact inputs, output,
screenshots/logs and reason; do not fill performance values before measuring.

| ID | Path / procedure | Acceptance / evidence |
|---|---|---|
| I1 | Clean install, sign in, open On-device AI (Settings → AI & models → On-device AI) without a provider key. Inspect before any tap. | No model auto-download/load/probe; no fabricated installed state. Build/About identity and initial screenshot. |
| D1 | Select Needle → Download; record progress → Pause → Resume. Repeat with SmolVLM2. | Real byte counts, responsive pause, retained staged bytes, HTTPS Range resume, full checksum verification before installed. Record transferred offsets and transitions, not invented percentages. |
| D2 | Kill/relaunch during a partial download, resume; restart after a completed install. | Partial bytes recover as resumable; completed installs rehash against current pin. Corrupt/truncated weights must not enter the picker. Never restore resident state from disk. |
| D3 | Remove each model, repeat; attempt removal during inference or measurement. | Runtime ownership prevents deletion while busy; remove releases resident then staged/installed/journal files and revokes availability. Missing files are idempotent; failures remain visible. |
| V1 | Install Smol, remove cloud keys; Help → Choose model → installed Smol → explicitly approve red/blue and real object photos → send. | CPU cold-load and image description work offline after install. Unapproved images excluded, no provider-key request/network fallback. Retain prompts, image fixture hashes, raw answers and correctness judgment. |
| V2 | Measure CPU, then Measure GPU (service seam; the in-app screen is gone); repeat with a driver/init failure or unsupported GPU. | Valid counters + correctness per arm, or explicit unavailable/error. Fast wrong output never wins. If a measured GPU later fails load, show CPU retry notice; fail visibly if CPU also fails. |
| N1 | Needle Help prompt: supplied item title/description/location details. Include ambiguous and unsupported questions. | Native structured extraction only; preserve uncertainty and supplied details. Do not evaluate Needle as a general chatbot or auto-apply fields. |
| N2 | Seed fixed opposite-type open report candidates; evaluate Possible Matches with USE, then explicitly select installed Needle. | Real native vectors; transparent top-3 ranking; no wrong-type/closed posts. Record candidate IDs/texts and rankings for both arms; no automatic Needle promotion. Remove Needle/restart → default USE. |
| H1 | Inspect hardware (`service.facts()`); correlate output with Android/driver facts. | Record NNAPI devices, Vulkan/OpenCL availability and discovery errors. Do not label discovery as executed inference, correctness, or speed. |
| P1 | CPU/GPU measurements from cold start, then at least five warm repeats, same fixtures/model/OS. | Raw records: TTFT ms, decode tokens/s, correctness, corpus/probe/revision. Separate model-load wall time from SDK TTFT. Report median/range; missing counters are unavailable, never zero-filled. |
| R1 | Sample process memory before load, after Needle, after Smol, after unload/remove; exercise low-memory/restart. | RAM/peak footprint and release behavior, no overlapping generative residents or false readiness after eviction. Capture `adb shell dumpsys meminfo com.findback.app` per phase. |
| L1 | Smol stream → Stop; switch screen/model, background/foreground, rotate, force-stop/relaunch. Retry after cancellation/error. | Correct generation-ID isolation, no stale chunks, listener cleanup, no double engines/native crash; restored verified files require a fresh runtime load. Needle Stop must suppress late output; its bounded native call has no token-level cancellation API. |
| T1 | Fixed repeated CPU/GPU workload; capture initial/final thermal and battery state, durations and charging condition. | Battery delta/thermal throttling evidence, UI responsiveness and sustained-rate range; no broad battery or acceleration claims from one run. |
| U1 | Keyboard/screen reader, large text, navigation and touch controls; unplug network during download. | Labeled model/matching selectors, progress and notices announced, usable Pause/Resume/Remove, clear recovery paths. Offline-only never sends to cloud; unsupported model/task preserves the draft. |
| W1 | Open web build → On-device AI (Settings → AI & models → On-device AI) / Help; choose stale offline selection if possible. | No native downloads/inference, honest refusal, cloud and built-in fallback still function within their selected mode. |
| W2 | Whole-app visual walkthrough on the signed candidate: onboarding, login/register/recovery, Home, Search, Create Report, profiles, comments, notifications, full Settings hierarchy, Help/Assistant, maps, account deletion — at phone width, light/dark, large text. | Each route renders its loading/empty/error/content states without overflow, generic placeholder UI, or developer-facing copy; record a screenshot per route plus failures with steps. This row is the formal whole-app rendered acceptance (host automation covers AI catalogue + shared transitions only). |

## Evidence and close-out

Store results in a dated private evidence directory (for example
`test-evidence/gate-e/<run>/`) with build identity, matrix statuses, screenshot
references, redacted raw probe records, prompts/fixture hashes, memory/thermal/
battery samples and logcat crash/error excerpts. Avoid keys, account credentials,
or personal photos in committed evidence.

Useful read-only captures after the authorized run:

```bash
adb -s <serial> shell dumpsys meminfo com.findback.app
adb -s <serial> shell dumpsys thermalservice
adb -s <serial> shell dumpsys battery
adb -s <serial> logcat -d -v threadtime
```

TTFT is the mean of two corpus samples in each current native probe; tokens/s is
the mean of the SDK decode rates. The two-color gate is a backend sanity check,
not general vision quality acceptance. Real object-photo output, lifecycle,
memory, battery and UX require their own matrix evidence. Records currently stay
in the application session; copy them before restarting. Gate success and JVM
fakes prove software wiring, not Civi 3 hardware acceptance.
