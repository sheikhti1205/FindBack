# Local generative AI — archived 2026-09-25

Owner decision: development suspended. This branch/tag preserves the production six-model implementation from `1718d50` together with the uncommitted post-audit progress that was in the `main` working tree when the pivot arrived. This is historical source, **not** the OpenRouter implementation.

## What this snapshot contains

- Six-model v1 catalogue and pinned model identities: SmolVLM2 500M, Qwen3 0.6B (recommended and experimental distributions), LFM2.5 1.2B and LFM2.5-VL 450M fixB. Model binaries were distributed separately through `FindBack-Models` releases; they are not embedded in Git or this archive.
- Android LiteRT-LM engines, candidate runtime, package import/export, residency arbiter, model storage, native bridge, status and diagnostics. Android implementation lives under `apps/mobile/android/app/src/main/java/com/findback/app/vlm/`; Gradle dependencies are in `apps/mobile/android/app/build.gradle`.
- Mobile model-library, downloads, local text/image inference, editor/report and guided-assistant integration under `apps/mobile/src/`; model catalogue specifications, tests, runbooks and benchmark/experimental documentation remain in their existing locations.
- Post-`1718d50` audit work: atomic native candidate handle/lease acquisition, candidate inference phase events, truthful backend/status reporting, editor toolbar/typography/selection/count/link/list improvements, assistant and model-state reconciliation, new regression tests and revised device runbooks.

## State and limitations at archiving

- Prior to the post-audit edits, `1718d50` was pushed on `origin/main`; its canonical debug APK was 206,556,836 bytes, SHA-256 `5b2165f90c16c66883094acc94276d9303fa97ebbb25206023ef43cd3a4db7ea`. It does **not** contain this archive commit's uncommitted-at-pivot work.
- The post-audit work was tested in separate worker passes (editor and Kotlin unit tests), but no integrated verification/build was completed after all edits. The native worker's last report lists 329 JVM tests and the editor worker's last report lists 1063 mobile tests; these are worker-reported results, **not** proof of a final integrated APK.
- Four experimental candidate engines and the candidate phase UI were never accepted on a physical Android device in this environment. No device compatibility, memory safety, cancellation behavior or visual IME/touch proof is claimed.
- Known local-runtime gaps at handoff included lack of a candidate-text ActiveInference cancellation token and unverified Capacitor listener delivery on hardware. Findings in the independent review were partly contradicted by source; re-evaluate rather than treating the review as authoritative.
- The old `ai-help` Edge Function could use an environment-configured generic provider/model and otherwise fell back to deterministic answers. It was not BYOK/OpenRouter-only.
- Historical notes and laboratory evidence are preserved in `FindBack-internal` and existing frozen lab worktrees. No model downloads or further compatibility experiments are authorized under the pivot.

## Restoration

The annotated immutable tag `local-ai-final-2026-09-25` points at this snapshot; the archive branch is `archive/local-generative-ai-2026-09-25`. To inspect without changing active `main`, run `git worktree add /path/to/temporary-checkout local-ai-final-2026-09-25` in the FindBack repository. To restore only a needed historical file, use `git show local-ai-final-2026-09-25:<repo-relative-path>` or `git restore --source=local-ai-final-2026-09-25 -- <paths>` on a new working branch. Re-enabling local generation requires a new owner decision and fresh tests/device proof; do not silently merge this archive into the OpenRouter app.
