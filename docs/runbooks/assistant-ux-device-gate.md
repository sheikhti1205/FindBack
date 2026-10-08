# Assistant + Media + Model UX — ARM64 device gate (U6, reviewer-owned)

**Status: NOT RUN.** No physical device was available during U1–U5 (owner
order 2026-10-08: no device until the reviewer verifies). Nothing below is
claimed — the reviewer runs it on the Xiaomi (or equivalent ARM64) and records
evidence here before any GGUF/Qwen expansion.

Build under test (reviewer fills):
- APK SHA-256: ___
- versionName / versionCode: ___
- Repo HEAD: ___

## Gate rows

### Conversation correctness
- [ ] One send → exactly one assistant bubble (text and image sends).
- [ ] No resurrected partial after completion, failure, stop, chat switch, or
      account switch.
- [ ] Stop-while-streaming keeps the draft; retry never duplicates turns.

### Streaming quality (measure, then tune)
- [ ] Record native `visionChunk` cadence: chunk count + first/last timestamps
      for a standard image answer (Diag/logcat).
- [ ] Record UI paint cadence for the same answer (partial updates painted).
- [ ] If chunks arrive faster than paints, lower the 120 ms throttle toward
      50–80 ms and re-measure. Do not fake character typing.
- [ ] Scrolling up mid-stream stops auto-follow; no yank-back.
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

### Media intake (real camera media)
- [ ] Xiaomi 4928×6560 JPEG attaches and analyzes (was refused pre-U4).
- [ ] 48 MP capture attaches via downsampling.
- [ ] Motion Photo attaches as still with "Motion photo · still frame used"
      disclosure; video tail never uploaded.
- [ ] >16 MB ordinary camera file attaches (was refused pre-U4).
- [ ] Corrupt/malicious-dimension input still refused with consumer-safe copy.
- [ ] GPS stripped from derivatives.

### Privacy / isolation
- [ ] On-device-only: airplane-mode image+text send never touches network
      (logcat/proxy proof).
- [ ] Privacy & AI sheet reachable from overflow; no transcript chrome.
- [ ] Response details show honest provenance, never fabricated.

### Residency / lifecycle (existing ARM64 gate, re-run)
- [ ] Residency switching, cancellation, reset barrier, memory/thermal rows
      from `phase-a-device-acceptance.md`.

## Exit
All boxes evidenced (screenshots + logs in
`FindBack-internal/04_EVIDENCE/visual/`). Only then may Phase B GGUF/Qwen
expansion begin.
