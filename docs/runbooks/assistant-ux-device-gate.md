# Assistant + Media + Model UX — ARM64 device gate (U6, reviewer-owned)

**Status: NOT RUN.** No physical device was available during U1–U5 (owner
order 2026-10-08: no device until the reviewer verifies). Nothing below is
claimed — the reviewer runs it on the Xiaomi (or equivalent ARM64) and records
evidence here before any GGUF/Qwen expansion.

Pre-U6 revision (2026-10-08): the consumer fixes that closed the reviewer
NO_GO (routing, media, privacy, status, streaming cadence, free-first
recommendations) are code-complete and host-verified, but **none of the rows
below have run on hardware**. Screenshots must be keyed to the APK/repo SHA.

Build under test (reviewer fills):
- APK SHA-256: ___
- versionName / versionCode: ___
- Repo HEAD: ___

## Gate rows

### Conversation correctness
- [ ] One send → exactly one assistant bubble (text and image sends).
- [ ] A retry whose first attempt streamed a partial never concatenates the two
      attempts (attempt 1 "SAME ANSWER" → retryable error → attempt 2 "SAME
      ANSWER" must persist exactly once).
- [ ] No partial bubble survives completion/failure/cancellation (the final
      answer is rendered only from the persisted turn).
- [ ] A failed attempt's partial is gone before a cloud fallback or built-in
      fallback answer appears (no stale local text beside the cloud/built-in answer).
- [ ] A fast double-tap on Send creates exactly one request.
- [ ] No resurrected partial after completion, failure, stop, chat switch, or
      account switch.
- [ ] Stop-while-streaming keeps the draft; retry never duplicates turns.
- [ ] Exactly ONE consolidated status region is visible at a time (never a
      stacked request-state + error + cancelled set).

### Routing (Automatic + manual, 4 modes)
- [ ] Automatic + text, no cloud key → built-in FindBack guidance only; no
      on-device text-chat engine is claimed (no Needle, no extraction answer).
- [ ] Automatic + photo, on-device Vision installed → on-device first; local
      failure never silently switches to cloud.
- [ ] Automatic + photo, no key and no Vision → fails closed (draft + photos
      kept), never a substitute FAQ prose answer.
- [ ] Manual pin of an incompatible model refuses honestly with the draft kept
      (no silent switch, no `Saved default unavailable` fallback surprise).
- [ ] cloud-only skips local inference; on-device-only never reads a cloud key.

### Streaming quality (measure, then tune)
- [ ] Record native `visionChunk` cadence: chunk count + first/last timestamps
      for a standard image answer (Diag/logcat).
- [ ] Record UI paint cadence for the same answer (partial updates painted).
- [ ] Confirm the adaptive 50–80 ms coalescing never restarts its deadline per
      chunk (one paint per window, not per chunk). No fake character typing.
- [ ] Scrolling up mid-stream stops auto-follow; no yank-back or repeated
      smooth-scroll.
- [ ] Right-edge scroll control: appears only away from bottom, hides during
      active scroll, reappears ~200 ms after idle, dot on unseen content,
      reduced-motion jumps.

### Repetition (anti-repeat decode)
- [ ] Re-run `smol-color-plate-v1` (red plate + standard rows) after the U5
      decode change (repetition penalty 1.1, no-repeat 3-gram).
- [ ] No verbatim sentence loops in image answers; correctness corpus still
      passes (color-only expected answers).
- [ ] If loops persist, adjust penalty/n-gram and re-measure — never weaken
      validators to pass.

### Model taxonomy / pickers
- [ ] Needle appears NOWHERE in the Assistant picker (Automatic, Chat, Vision).
- [ ] Needle visible in Settings → AI models → Tools/Embeddings library.
- [ ] Stale Needle pin refuses honestly with draft kept.
- [ ] SmolVLM2 under Vision with Local badge; image + text-only pin explains
      incompatibility without silent switching.
- [ ] Rows show consumer display names, not raw model IDs as the primary label
      (raw ID stays under Technical details).
- [ ] Free models are listed first and marked **Recommended**; paid/unknown
      rows remain user-selectable.
- [ ] STT and TTS filters are present in the model library capability chips.

### Media intake (real camera media)
- [ ] Xiaomi 4928×6560 JPEG attaches and analyzes (was refused pre-U4).
- [ ] 48 MP capture attaches via native decode-time downsampling; original file
      is never materialized whole in JS on Android.
- [ ] Modern Motion Photo (`Camera:MotionPhoto` + `Container:Directory`)
      attaches as still with "Motion photo · still frame used" disclosure; the
      video tail is reported separately and never uploaded.
- [ ] Legacy MediaTek/Xiaomi Motion Photo still attaches as still.
- [ ] HEIC/HEIF/AVIF still image normalizes to JPEG (or PNG for alpha) on a
      supported device; unsupported codec fails with consumer-safe copy.
- [ ] >16 MB ordinary camera file attaches (was refused pre-U4).
- [ ] Preparation shows Preparing → Ready; a failure keeps a Retry/Remove row
      and blocks send from silently dropping the photo.
- [ ] Corrupt/malicious-dimension input still refused with consumer-safe copy;
      raw `content://` paths never surface.
- [ ] GPS/capture metadata stripped from derivatives.

### Privacy / isolation
- [ ] On-device-only: airplane-mode image+text send never touches network
      (logcat/proxy proof).
- [ ] Privacy & AI sheet is concise with a working **Full details** route
      (`/settings/ai/privacy`); no transcript chrome.
- [ ] "Open Privacy settings" opens the Privacy settings screen (not the AI
      connection screen).
- [ ] Response details show honest provenance, never fabricated.

### Residency / lifecycle (existing ARM64 gate, re-run)
- [ ] Residency switching, cancellation, reset barrier, memory/thermal rows
      from `phase-a-device-acceptance.md`.

## Exit
All boxes evidenced (screenshots + logs in
`FindBack-internal/04_EVIDENCE/visual/`, filenames keyed to the APK/repo SHA).
Only then may Phase B GGUF/Qwen expansion begin.
