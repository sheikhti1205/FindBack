# Runbook X2 — Native model device-day run (SmolVLM2 + Qwen)

Ordered pass. One generative model resident at a time (G7): every switch is
release-current → load-next → verify. Evidence lands in
`test-evidence/native-models/<run>/`.

Qualified pins (never re-resolve, never substitute):

| Model | File | rev | installed bytes | sha256 |
| --- | --- | --- | --- | --- |
| SmolVLM2-500M INT4 | `SmolVLM2-500M.litertlm` | `dad030b6e56756201d670cfb4d042736a2ce3a5c` | catalogue `downloadBytes` | `b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0` |
| Qwen3-0.6B dynamic INT4 | `Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm` | `a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76` | 344671744 | `03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856` |

## Steps

Precondition (W audit `20260922T140000-w-truth2-status-01.md` B1): the
`FindBack-Models` tag `models-2026-09-22-v1` is unpublished until the owner
publishes it — Download fails closed with honest `DOWNLOAD_FAILED` until
then. Record which outcome occurred in steps 1–2; never treat it as success.

1. **SmolVLM2 download + verify.** Offline AI → Download `smolvlm2-500m`.
   Expected states: `NOT_INSTALLED` → `DOWNLOADING` → `INSTALLED_UNVERIFIED`
   → `READY_GPU` after self-test. Evidence: `01-smol-download.json`
   (states + bytes + sha match against the pin above).
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

## Forbidden

Cross-role routing (image→Qwen, text→SmolVLM) and two resident engines.
Any deviation fails the run.
