# Phase A — physical ARM64 acceptance run

**Status: EXECUTED 2026-10-08 — verdict `PHASE_A_DEVICE_FAIL`.** Real ARM64 phone,
current `main`. This records what the device actually did; it does not propose or
apply fixes.

| | |
| --- | --- |
| Code baseline | `7a0521dfa31f023fd14bb313e6130124bb57e865` (clean tree) |
| Artifact | signed `app-arm64-v8a-release.apk` (release keystore `CN=FindBack`) |
| APK SHA256 | `b205668349d19e530800101014e8a4c6f5b2f5c12a8b354e338e132a7e8c0acb` |
| versionName / code | `0.9.0-beta.1` / `100493` |
| Build checks | pre-build Supabase assert, `check-release-config.mjs` PASS, `scan-apk.mjs` clean |

## Device identity

| | |
| --- | --- |
| Device | Xiaomi `23046PNC9C` (codename `yuechu`) |
| Android / patch / API | 15 / 2026-06-01 / 35 (`AP3A.240905.015.A2`) |
| ABI | `arm64-v8a` (abilist also `armeabi-v7a`, `armeabi`) |
| SoC | MediaTek MT6896 |
| GPU | ARM Mali-G610 MC6 (OpenGL ES 3.2) |
| RAM | 7,613,104 kB (~7.4 GB); app-reported `ramMb: 7434` |
| Storage / battery / thermal | ~142 GB free; 87% discharging; status 0 |

`DeviceFacts` agreed with the physical device (ABI, SoC, GPU). Serial not recorded.

## Results

| § | Area | Result |
| --- | --- | --- |
| C | Model manager | **PASS** — both models installed, sizes and revisions match pins |
| D | Needle structured inference | **FAIL** — empty `function_calls` |
| E | Smol image inference | **FAIL** — audio-encoder not found |
| F | CPU measurement | **FAIL** — same audio-encoder error |
| G | GPU measurement | **FAIL** — same error (GPU path never reached) |
| H | Residency switching | NOT EXERCISED — Smol cannot reach a resident state |
| I | Cancellation | PARTIAL — Needle route abort reachable; Smol native cancel unreachable |
| J | Reset barrier | NOT EXERCISED — real native work settles ~2 s, far under the wait |
| K | Offline proof | NOT EXERCISED — device is on wireless ADB; failed legs are local engine errors |
| L | Memory / thermal | app PSS ≈ 236 MB idle-after-failure; thermal 0; no OOM/ANR |

### C. Model manager (PASS)

Both artifacts present under app-private `files/ai-models/models/<id>/<rev>/`:

| Model | File | rev | bytes | State |
| --- | --- | --- | --- | --- |
| Needle | `needle3.cact` | `c7c415a3d1b3d929014bc6e866d51ebb971f7089` | 35,335,380 | installed · checksum verified |
| SmolVLM2 | `SmolVLM2-500M.litertlm` | `dad030b6e56756201d670cfb4d042736a2ce3a5c` | 360,822,960 | installed · checksum verified |

Restart preserved READY only through rehash (no persisted trust).

### D. Needle (FAIL)

The engine loads, embeds and generates; the tool call comes back empty:

```
loadNeedleModel modelId=needle3-cact-l20 file=…/needle3.cact
needle nativeLoad ok kinds=1            # NEEDLE_TEXT present
needle embedDim=3072                    # embeddings work
initNeedleTools system=Extract only supplied item details.
  tools=[{"name":"record_item","description":"Record item details","parameters":{…}}]
initNeedleTools ok
needle complete ok len=269
  {"type":"call","success":true,"error":null,"error_code":null,"function_calls":[],
   "suppressed_calls":[],"reasoning":"No tool available for file management or system operations.",
   "confidence":0.2953,"prefill_tps":542.8,"decode_tps":64.2,"peak_ram_mb":442.7}
```

`extractTaskFields` then throws (`no confident record_item`), so the UI shows
“Couldn't draft suggestions from that text.” Reproduced with two different inputs;
temperature 0.0, so deterministic. `extract-report-fields`,
`extract-search-filters` and `classify-category` are all affected; the embedding
path is fine.

### E. Smol (FAIL)

Product path (Report → photo → Suggest title & description, on-device):

```
smol: load initialize backend=cpu file=…/SmolVLM2-500M.litertlm
smol: initialize ok
smol: load FAILED: Failed to create conversation:
  NOT_FOUND: TF_LITE_AUDIO_ENCODER_HW not found in the model.
```

UI: “On-device photo analysis isn't available on this device.” No cloud request,
no upload (mode = On-device only).

### F/G. Measurement (FAIL)

`Measure CPU` and `Measure GPU` both surface:

```
Measurement failed (engine failure: Failed to create conversation:
NOT_FOUND: TF_LITE_AUDIO_ENCODER_HW not found in the model. runtime_init_failed)
```

GPU is never auto-selected, and CPU is not falsified as a pass.

## Root cause of E, F, G

Both call sites force a CPU audio backend that the SmolVLM2 model does not carry:

- `apps/mobile/android/app/src/main/java/com/findback/app/vlm/SmolVlmPlugin.kt:190`
- `apps/mobile/android/app/src/main/java/com/findback/app/vlm/RuntimeTimingRunner.kt:157`

```kotlin
val config = EngineConfig(
    modelPath = modelFile.absolutePath,
    backend = Backend.CPU(),
    visionBackend = visionBackend,
    audioBackend = Backend.CPU(),   // <- forces an audio pipeline the model lacks
    cacheDir = context.cacheDir.path,
)
```

The pinned `litertlm-android 0.17.1` `EngineConfig` default constructor leaves
`audioBackend` **null** and defaults `visionBackend` to `Backend.CPU()` (verified
from the AAR bytecode: `EngineConfig(...DefaultConstructorMarker)` sets
`audioBackend` to null, not `Backend.CPU()`). Forcing `Backend.CPU()` makes
`createConversation` build an audio subgraph; because
`TF_LITE_AUDIO_ENCODER_HW` is absent from the model, it fails with `NOT_FOUND`.
`engine.initialize()` succeeds; `createConversation` fails — matching the observed
logs. This affects measurement (F/G) and production vision (E) identically.

## Secondary finding

Settings → On-device AI → Advanced shows “Offline use is hidden: no verified model
is installed on this device” while both model cards read “installed · checksum
verified”. The offline capability signal and the model-manager state disagree
(`getOfflineCapabilityCopy` × `hasVerifiedOfflineModel`). Cosmetic, but
contradictory copy on the same screen.

## Verdict

`PHASE_A_DEVICE_FAIL`. Three P0 blockers, all repeatable at 100%:

1. SmolVLM2 vision unusable (audio-encoder).
2. CPU/GPU measurement unusable (same cause).
3. Needle structured extraction unusable (empty `function_calls`).

## A.4 follow-up: oracle comparison (Needle root cause proven)

Official `cactus-needle` 3.1.2 on desktop CPU, same extraction task,
controlled A/B — no device, no JNI, no triggers involved:

| Input shape | Tool schema | Result |
| --- | --- | --- |
| Engineered cloud-style prompt (`"Extract report slots. Return ONLY one JSON object … User message: Lost a red umbrella near CUET gate yesterday."`) + steering system | `record_item`, `required: ["title"]`, weak descriptions | `function_calls: []`, reasoning `"No tool available for file management or document retrieval."` — **reproduces the device failure verbatim** |
| Raw user request (`"Lost a red umbrella near CUET gate yesterday."`) | `record_item`, `required: []`, action-naming descriptions | `{"title": "Red umbrella near CUET gate", "description": …, "category": "umbrella", "dateText": "yesterday"}` — **extracts** |

Conclusion: the model, the JNI bridge (`needle_init(system, tools, nullptr)`),
the absent tool index, and the MediaTek phone are all exonerated. The defect
is purely the integration contract: FindBack fed a chat-LLM instruction
prompt plus a stricter-than-app schema into a tool model. Fixes (raw
`localTaskInput` for the local route, `required: []`, enum-bound category,
no `confidence` argument) match the oracle-winning shape exactly.

## Candidate fixes (NOT applied)

1. **Smol + measurement** — likely one-line each: drop the `audioBackend`
   argument (let it default to null) in `SmolVlmPlugin.kt` and
   `RuntimeTimingRunner.kt`; keep `backend = Backend.CPU()` and `visionBackend`
   per request. Re-run §E, §F, §G after.
2. **Needle tool-calling** — the model returns an empty `function_calls` for the
   `record_item` envelope despite a successful `needle_init`. Needs investigation
   against the pinned needle3 engine (envelope/prompt format, or the
   `tool_index_path` argument currently passed as null), not a blind edit.

## Evidence and reproduction notes

- MIUI suppresses third-party `logcat` entirely (no app tag ever reaches the
  buffer), so the native reject reason was captured with temporary file
  diagnostics under the app's pullable external files dir. That instrumentation
  was reverted; the clean rebuild reproduced the identical APK SHA
  `b2056683…`, and the device was restored to the unmodified build.
- Screenshots and the raw `diag.log` from the run were kept outside the repo
  (`/tmp`). In-repo evidence belongs under the gitignored `test-evidence/`.
