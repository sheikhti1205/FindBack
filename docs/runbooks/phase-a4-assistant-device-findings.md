# Phase A.4 — Assistant on-device device findings (2026-10-08)

**Status: OPEN — defects found on the physical Xiaomi (yuechu, Android 15 / SDK 35,
arm64-v8a, MediaTek MT6896, Mali-G610 MC6). Fixes require a dedicated wave.**

This is a device-observation report, not a closure. It records what the assistant
did on real hardware, the confirmed root cause where one is proven, and the
planned fixes. Evidence screenshots live outside the repo in the owner Drive
internals folder (paths below).

## Build under test

- APK: `apps/mobile/android/app/build/outputs/apk/release/app-arm64-v8a-release.apk`
- versionName `0.9.0-beta.1`, versionCode `100499`
- SHA-256 `0703efeeb3670fe61df409827a570802d3a15637c08dd37c45cbf25c08c6a771`
- Installed in place over the prior build (same signing key; installed models kept).
- Repo HEAD at observation: `afb3ff8`.
- Installed models: Needle `needle3.cact` (rev `c7c415a3…`), Smol
  `SmolVLM2-500M.litertlm` (rev `dad030b6…`), both `installed · checksum verified`.

## Evidence (owner Drive)

`My Drive/FindBack-internal/04_EVIDENCE/visual/2026-10-08-assistant-device-findings/`

- `01-vision-answer-red-plate-2026-10-08.png` — SmolVLM2 correctly describes a red plate.
- `02-duplicate-answer-and-chrome-block-2026-10-08.png` — one user message, two
  identical answers, plus the intrusive chrome block.
- `03-decode-refusal-oversized-jpeg-2026-10-08.png` — oversized camera JPEG refused.
- `04-send-failed-and-decode-refusal-2026-10-08.png` — send-failed row + refusal.
- `05-answer-new-response-pill-2026-10-08.png` — centered “New response” pill.

## Findings

### F1 (P0) — One message produces two identical AI answers — ROOT CAUSE CONFIRMED

**Symptom.** One user message rendered two identical assistant bubbles
(`02-…png`). A screen dump of that state showed two `AI ANSWER` labels.

**Root cause (reproduced deterministically).** The controller subscription in
`apps/mobile/src/screens/Help.tsx:641` throttles streaming partials with a
120 ms `setTimeout` that calls `setPartial(...)`. On completion the success path
calls `setPartial(null)` (`Help.tsx:1046`) but does **not** clear that pending
timer. The timer therefore fires *after* completion and re-adds the partial
bubble, so the final answer is on screen twice: the persisted turn *and* the
resurrected partial. The same gap exists on the error/cancel paths that call
`setPartial(null)`.

Reproduction (Vitest, jsdom, single cloud send):

```
IMMEDIATE      partials: 0  messages: 2
AFTER 600 ms   partials: 1  messages: 2   ← duplicate text
```

Files:

- `apps/mobile/src/screens/Help.tsx:641-671` — throttled partial timer.
- `apps/mobile/src/screens/Help.tsx:1046-1048` — terminal `setPartial(null)` without timer clear.
- `apps/mobile/src/components/ChatTranscript.tsx:289-306` — partial bubble render.

**Fix.** Cancel `partialTimer` on every terminal transition (success, error,
cancel) and/or clear it inside the subscription whenever `phase !== "streaming"`.
Add a regression test asserting exactly one assistant bubble after a send settles.

### F2 (P1) — “Streaming” arrives as one blob instead of typing out

**Symptom.** The SmolVLM2 answer appears all at once; the user asked for
incremental typing.

**Analysis.** The pipeline is stream-capable end to end: LiteRT-LM
`Conversation.sendMessageAsync` emits per-chunk `Message` callbacks (verified in
`litertlm-android 0.17.1`), `SmolVlmPlugin.describeImage` forwards each
`message.toString()` as a `visionChunk` delta, and `CapacitorSmolVlmBridge`
yields each delta. The likely causes are (a) SmolVLM2-500M emitting tokens
faster than the 120 ms UI throttle, and (b) the completion path collapsing the
partial before the user perceives it. F1 also makes the finished answer look
like two responses.

**Plan.** Instrument `visionChunk` cadence (count + first/last timestamps via
`Diag`), measure the observed partial-update cadence, and lower/adapt the throttle
so tokens paint progressively. Confirm whether native chunks are batched.

### F3 (P2) — Assistant screen chrome is intrusive

**Symptom/request.** Remove the large block on the assistant side
(“New response”, “How your data is used”, “Open help”). Keep that copy on the
Help/guide side. Make the conversation non-intrusive and move scroll-to-latest to
a right-edge arrow button that hides while scrolling and reappears when not at the
bottom.

Files:

- `apps/mobile/src/screens/Help.tsx:1768` — “How your data is used”.
- `apps/mobile/src/screens/Help.tsx` — “Open help” pill.
- `apps/mobile/src/components/ChatTranscript.tsx:383-406` — centered “New response” pill
  (`05-…png`).

**Fix.** Relocate the data-use/privacy copy into the Help guide; drop the
“Open help”/data-use block from the conversation surface; replace the centered
pill with a floating right-edge scroll-to-latest control that shows only when the
transcript is not at the bottom.

### F4 (P1) — Motion photos and oversized camera JPEGs cannot be attached

**Symptom.** The picker labelled the file `Motion Photo` (dump:
`Motion Photo taken on Oct 8, 2026, 4:00:26 PM`); selecting it produced no
attachment. A real Xiaomi photo (`1000026950.jpg`, 4928×6560) was refused:

```
"1000026950.jpg" declares 4928x6560 pixels, over the 30,000,000-pixel decode
bound. Decoding was refused to protect memory — nothing was imported.
```

**Root cause.** The import path rejects instead of downscaling.
4928×6560 = 32,327,680 px > 30,000,000. `IMPORT_MAX_INPUT_BYTES = 16_000_000`
also refuses ≥16 MB files before any resize, so most modern phone captures can
never attach.

Files:

- `apps/mobile/src/services/media/importImage.ts:16-18` — `IMPORT_MAX_INPUT_BYTES`,
  `IMPORT_MAX_DECODE_PIXELS = 30_000_000`, `IMPORT_MAX_EDGE = 1920`.
- `apps/mobile/src/services/media/importImage.ts:578-586` — hard `PIXEL_BOMB` refusal.
- `apps/mobile/src/services/photo.ts:330-333` — `MAX_ORIGINAL_BYTES` size guard.
- `apps/mobile/src/services/photo.ts:381-382` — still-level decode backstop.
- `apps/mobile/src/services/media/motionPhoto.ts` — still/tail parser (runs, but
  the container never reaches it because the guard fires first for big files).

**Fix (owner directive: do not hard-restrict the device).** Decode with
downsampling (`createImageBitmap`/`ImageDecoder` `desiredWidth`/`desiredHeight`,
or canvas draw at `IMPORT_MAX_EDGE`) so oversized inputs are scaled rather than
refused. Keep only a high pathological ceiling for genuine pixel bombs. Extract
the Motion Photo still before decode and route it through the same downscaler.
Add real smartphone fixtures and retention/decode-time tests. Raises the input
size cap in step with the downscaler so a 48 MP capture attaches.

### F5 (P2) — On-device Smol answer repeats/loops

**Symptom.** The live answer repeated a sentence verbatim
(“The image does not contain any text or any other objects…”), which also reads
as “two responses”.

**Analysis.** The conversation uses greedy sampling with no anti-repetition
control: `SamplerConfig(topK = 40, topP = 1.0, temperature = 0.0)` in
`SmolVlmPlugin.kt:201-210`. LiteRT-LM 0.17.1 exposes
`RepetitionPenaltyConfig`/`NoRepeatNgramConfig` on
`ConversationConfig`/`sendMessage` (verified in the API).

**Fix.** Add a repetition penalty / no-repeat n-gram, or a decode-time repetition
guard; re-measure with the color-plate corpus.

### F6 (P1) — Needle extraction always failed on device — FIXED IN WORKING TREE

**Symptom (observed this session).** “Suggest fields” returned
“Couldn't draft suggestions from that text” for plain input.

**Root cause (proven against the official engine).** Needle returns extraction in
`suppressed_calls` (it withholds auto-execution), not `function_calls`. The app
read only `function_calls`, so it always saw an empty result. The official
`cactus-needle` reference reads `function_calls or suppressed_calls`
(`needle/__init__.py` `extract()`), which we confirmed reproduces the device
failure with the old shape and succeeds with the fixed shape.

Files: `apps/mobile/src/services/ai/applicationAi.ts` (read `suppressed_calls`
fallback) + regression test in
`apps/mobile/src/services/ai/advertisedRoles.test.ts`. Gates: typecheck, eslint,
mobile suite green.

## Planned fix order

1. **F1** (P0) — timer cancellation + regression test. Small, deterministic.
2. **F6** (P1) — already implemented; lands with this report.
3. **F4** (P1) — downsample-not-refuse import path; unblocks all attachment testing.
4. **F3** (P2) — remove assistant chrome block; right-edge scroll-to-latest control.
5. **F2/F5** (P1/P2) — streaming cadence + anti-repetition decode; requires a
   rebuild and a re-run of the ARM64 acceptance gate.

## Verification caveat

The wireless-debug endpoint was ephemeral and dropped mid-session, so the
remaining sections of the ARM64 gate (residency switching, cancellation, reset
barrier, offline airplane proof, memory/thermal rows) were not re-run after these
observations. They remain open for the next device pass.
