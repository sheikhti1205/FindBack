# Pivot reconciliation — local checkout

Observed date/time: 2026-09-25 (worker B, mimo-v2.6-flash-free)
Repo path / branch / HEAD / origin/main: `/home/sheikh/GitHub/FindBack` · `main` · `1718d5073071105eb2dc635cf1a8ce4c623dc64f` · `origin/main = 1718d5073071105eb2dc635cf1a8ce4c623dc64f` (equal)
Archive SHA + tag dereference: `refs/heads/archive/local-generative-ai-2026-09-25 = 282367cc228e7af62cc8034d343dcc34f3e54c46`; `refs/tags/local-ai-final-2026-09-25^{} = 282367cc228e7af62cc8034d343dcc34f3e54c46` (archive untouched)
Initial `git status` counts (modified, deleted, untracked, staged, ignored build outputs): **26 M / 106 D / 19 ?? / 0 staged**; no build outputs staged.
Inventory source: `/tmp/opencode/phase0/status-porcelain.txt` (151 lines) — live `git status --porcelain=v1 -uall` re-count at reconciliation time = **151** (match).
`git diff --check` = clean (exit 0, no whitespace/conflict markers).
No `desktop.ini` anywhere in the repo tree (`find . -name desktop.ini` → empty).

## Classification key

| Class | Meaning |
|---|---|
| KEEP-PIVOT | Implements the OpenRouter-only cloud pivot; keep and stage as pivot work. |
| KEEP-EDITOR | Editor/markdown improvement from archive `282367c`; preserve, never regress. |
| KEEP-NON-GENERATIVE | Retained because it is *not* local-generative (matching embedder, permissions, registrations). |
| REMOVE-OBSOLETE | Deletion is correct: local-generative runtime; content preserved in archive `282367c` + tag. |
| DOCUMENT-HISTORY | Kept as a decision/history record (documentation, not runtime). |
| UNCERTAIN | Needs supervisor/owner ruling before staging (see rationale). |

## Path note (pack vs reality)

The handover pack's migration map guesses `services/ai/openRouter.ts` and `services/ai/assistant/cloudAssistant.ts` (and `services/ai/cloudAssistant.ts`). **Actual dirty-tree paths are `apps/mobile/src/services/openRouter.ts` and `apps/mobile/src/services/assistant/cloudAssistant.ts`** — there is no `services/ai/` directory in this repo. `services/` at repo root is the separate backend workspace (`services/api/src/config.ts`), not the mobile AI client. All classifications below use the **actual** paths.

---

## 1. Modified files — 26 (each row = exactly one disposition)

| Path | Git status | Class | Rationale |
|---|---|---|---|
| `apps/mobile/android/app/build.gradle` | M | KEEP-NON-GENERATIVE | Drops `litertlm`/`litert`/`litert-gpu` + WorkManager + coroutines-test; **keeps** `com.google.mediapipe:tasks-text:1.0.0` and the pinned USE fetch task (`scripts/fetch-use-model.mjs`, output `assets/models/use/universal_sentence_encoder.tflite`). Generative deps removed, matching dep retained. |
| `apps/mobile/android/app/src/main/AndroidManifest.xml` | M | KEEP-NON-GENERATIVE | Removes `.vlm.ModelDownloadJobService`, WorkManager `SystemForegroundService`, `FOREGROUND_SERVICE*`/`RUN_USER_INITIATED_JOBS` permissions and GPU native-lib entries. Internet / network-state / coarse+fine location kept. |
| `apps/mobile/android/app/src/main/java/com/findback/app/MainActivity.java` | M | KEEP-NON-GENERATIVE | `LocalVlmPlugin` registration replaced by `EmbeddingPlugin`; adds `OpenRouterKeyPlugin`. `ShortLinkResolverPlugin` + `FindBackDiagPlugin` preserved as required. |
| `apps/mobile/android/app/src/main/java/com/findback/app/vlm/UniversalSentenceEmbedder.kt` | M | KEEP-NON-GENERATIVE | Isolated MediaPipe `TextEmbedder` (L2-normalised), no LiteRT-LM/vision/generation imports. Only change: stop echoing raw input text in the error message (privacy) + newline-at-EOF. |
| `apps/mobile/src/App.tsx` | M | KEEP-PIVOT | `/offline-ai` → `Navigate` to `/ai-connection`; `OfflineAiCompact` route element removed, `AiConnection` added. |
| `apps/mobile/src/auth.tsx` | M | KEEP-PIVOT | `aiCredentials.clearSession()` on `SIGNED_OUT`, `onSignedOut()` and `clearAllAuth()` — per-user key wipe. |
| `apps/mobile/src/components/AssistantSheet.test.tsx` | M | KEEP-PIVOT | Rewritten to cloud-adapter expectations (owner: worker A). |
| `apps/mobile/src/components/AssistantSheet.tsx` | M | KEEP-PIVOT | Cloud adapter + "AI-generated"/"Built-in guidance" labelling (owner: worker A). |
| `apps/mobile/src/components/MarkdownView.test.tsx` | M | KEEP-EDITOR | Assertions updated for the new distinct heading hierarchy. |
| `apps/mobile/src/components/MarkdownView.tsx` | M | KEEP-EDITOR | `headingMap` h1→h2, h2→h3, h3→h4 + `.fb-h1…fb-h6` classes; matches archive `282367c` **byte-for-byte** (verified). |
| `apps/mobile/src/components/RichTextEditor.test.tsx` | M | KEEP-EDITOR | Identical to archive `282367c` (verified). |
| `apps/mobile/src/components/RichTextEditor.tsx` | M | KEEP-EDITOR | 731 changed lines vs HEAD — identical to archive `282367c` (verified); floating block menu, ED-* fixes. |
| `apps/mobile/src/components/RichTextEditor.workset2.test.tsx` | M | KEEP-EDITOR | Toolbar-detection fix; identical to archive `282367c` (verified). |
| `apps/mobile/src/components/Shell.test.tsx` | M | KEEP-PIVOT | Cloud-only shell expectations (owner: worker A). |
| `apps/mobile/src/components/Shell.tsx` | M | KEEP-PIVOT | Cloud-only shell, no local runtime (owner: worker A). |
| `apps/mobile/src/components/VlmSuggestions.tsx` | M | KEEP-PIVOT | −393/+40: local `vlmDiscovery`/`getVlmBridge` path replaced by `analyzeReportPhoto` cloud flow (owner: worker A). |
| `apps/mobile/src/index.css` | M | KEEP-EDITOR | +44/−2: `.fb-markdown` heading/link/list-marker hierarchy + scoped `.tiptap` typography (ED-01). Identical to archive `282367c` (verified). |
| `apps/mobile/src/screens/About.test.tsx` | M | KEEP-PIVOT | Build-info expectations instead of VLM capabilities (owner: worker A). |
| `apps/mobile/src/screens/About.tsx` | M | KEEP-PIVOT | `getVlmBridge().getCapabilities()` → `readBuildInfo()` (owner: worker A). |
| `apps/mobile/src/screens/CreateReport.tsx` | M | KEEP-PIVOT | Dual-purpose file: **editor half is KEEP-EDITOR content** — `measureDescription` import (L11) and ED-05 `trimmedDescription = measureDescription(...)` (L402 + contract comment L403-406) are present and identical to archive. Pivot half removes `imageAnalysisReadiness`/`toNativeImageUri` gating and adds non-destructive AI-apply confirm. Single disposition KEEP-PIVOT with the editor hunks explicitly protected. |
| `apps/mobile/src/screens/Profile.tsx` | M | KEEP-PIVOT | "Offline AI settings" → "AI Connection" (`/ai-connection`, `KeyRound` icon). |
| `apps/mobile/src/services/auth.test.ts` | M | KEEP-PIVOT | `askAiHelp` now expects OpenRouter client + built-in fallback (owner: worker A). |
| `apps/mobile/src/services/auth.ts` | M | KEEP-PIVOT | `askAiHelp` calls `createOpenRouterClient(...).text(...)` with `builtInHelp` fallback; no Supabase `ai-help` invoke. |
| `apps/mobile/src/services/embeddings.test.ts` | M | KEEP-NON-GENERATIVE | Rewired from `getVlmBridge` mock to `registerPlugin("FindBackEmbeddings")` mock. |
| `apps/mobile/src/services/embeddings.ts` | M | KEEP-NON-GENERATIVE | **Decoupling seam**: no `vlmPlugin` import; own `EmbeddingBridge` interface + `registerPlugin("FindBackEmbeddings")`, platform/length/blank guards. |
| `apps/mobile/src/services/richText.ts` | M | KEEP-EDITOR | +50: `descriptionVisibleText` + `measureDescription` (ED-05 single source of truth). Identical to archive `282367c` (verified). |

## 2. Untracked files — 19 (each row = exactly one disposition)

| Path | Git status | Class | Rationale |
|---|---|---|---|
| `apps/mobile/android/app/src/main/java/com/findback/app/OpenRouterKeyPlugin.java` | ?? | KEEP-PIVOT | Android Keystore bridge for the per-user OpenRouter key. |
| `apps/mobile/android/app/src/main/java/com/findback/app/vlm/EmbeddingPlugin.kt` | ?? | KEEP-NON-GENERATIVE | Independent `FindBackEmbeddings` Capacitor plugin; validates ≤21 texts / ≤5000 chars, never echoes input text. Non-generative. |
| `apps/mobile/src/components/RichTextEditor.edAudit.test.tsx` | ?? | KEEP-EDITOR | New in archive `282367c`; worktree copy **byte-identical** to archive (verified via `git show 282367c:… \| diff`). Untracked only because it never existed at `1718d50`. |
| `apps/mobile/src/components/RichTextEditor.menus.test.tsx` | ?? | KEEP-EDITOR | Same as above — byte-identical to archive `282367c`. |
| `apps/mobile/src/components/VlmSuggestions.cloud.test.tsx` | ?? | KEEP-PIVOT | Cloud photo-analysis coverage for the rewritten `VlmSuggestions` (owner: worker A). |
| `apps/mobile/src/screens/AiConnection.test.tsx` | ?? | KEEP-PIVOT | Owner: worker A. Contains `sk-or-v1-abcdefgh1234` only as an obviously-fake masking fixture (see §6). |
| `apps/mobile/src/screens/AiConnection.tsx` | ?? | KEEP-PIVOT | Owner: worker A. |
| `apps/mobile/src/services/aiCredentials.ts` | ?? | KEEP-PIVOT | Owner: worker A. |
| `apps/mobile/src/services/analyzeReportPhoto.test.ts` | ?? | KEEP-PIVOT | Owner: worker A. |
| `apps/mobile/src/services/analyzeReportPhoto.ts` | ?? | KEEP-PIVOT | Owner: worker A. |
| `apps/mobile/src/services/assistant/cloudAssistant.test.ts` | ?? | KEEP-PIVOT | Owner: worker A. **Actual path** `services/assistant/…`, not the pack's `services/ai/…`. |
| `apps/mobile/src/services/assistant/cloudAssistant.ts` | ?? | KEEP-PIVOT | Owner: worker A. **Actual path** `services/assistant/…`. |
| `apps/mobile/src/services/browserAiCredentials.test.ts` | ?? | KEEP-PIVOT | Owner: worker A. |
| `apps/mobile/src/services/browserAiCredentials.ts` | ?? | KEEP-PIVOT | Owner: worker A. |
| `apps/mobile/src/services/buildInfo.ts` | ?? | KEEP-PIVOT | Owner: worker A. |
| `apps/mobile/src/services/helpFaq.ts` | ?? | KEEP-PIVOT | Built-in help fallback (owner: worker A). |
| `apps/mobile/src/services/openRouter.test.ts` | ?? | KEEP-PIVOT | Owner: worker A. **Actual path** `services/openRouter.ts`, not the pack's `services/ai/openRouter.ts`. |
| `apps/mobile/src/services/openRouter.ts` | ?? | KEEP-PIVOT | Owner: worker A. `OPENROUTER_MODEL = "openrouter/free"` fixed at the boundary. |
| `docs/specs/openrouter-only-pivot-2026-09-25.md` | ?? | DOCUMENT-HISTORY | Decision record for the pivot. Out of worker B's edit scope (docs/specs owned by supervisor); classified only. |

## 3. Deleted files — 106 (every path below = exactly one disposition)

### 3a. `REMOVE-OBSOLETE` — local-generative native runtime, 50 paths
Preserved in archive `282367c` / tag `local-ai-final-2026-09-25`. Verified with `git show HEAD:<path>` that each is generative-only (engine, download, package/import, transfer, residency, GPU/Qwen runtime) and has **no surviving caller** in the remaining native tree (`MainActivity.java` now registers only `ShortLinkResolverPlugin`, `FindBackDiagPlugin`, `OpenRouterKeyPlugin`, `EmbeddingPlugin`; remaining `vlm/` = `Diag.kt`, `EmbeddingPlugin.kt`, `UniversalSentenceEmbedder.kt`).

```
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ActiveInference.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/CandidateModelStatus.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/CandidateRuntimeController.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ChunkManifest.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ChunkTransferEngine.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/EngineAcquire.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/EngineInitOutcome.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/EnginePolicy.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ExportSelectionPolicy.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ExportTrustStore.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/GenerativeResidencyArbiter.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/GpuProbe.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ImagePreparer.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ImportCommitPolicy.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ImportedModelRegistry.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/InferenceMutex.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/InspectedProbeClassifier.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/KnownPackageIdentity.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/LocalVlmPlugin.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ModelDownloadJobService.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ModelDownloadScheduler.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ModelDownloadWorker.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ModelDownloader.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ModelInstallPolicy.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ModelStore.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/PackageCommitter.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/PackageHost.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/PackageInspectionStore.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/PinnedModelSources.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/ProgressThrottler.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/QwenLifecycle.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/QwenTextEngine.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/QwenTextRuntime.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/RestoredStateValidation.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/Sha256.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/SixModelCatalogue.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/TextRuntimeController.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/TextTransferState.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/Tflite256Probe.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/TransferControls.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/TransferEvents.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/TransferJournal.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/TransferReconcile.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/TransferRetryPolicy.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/VerifiedWeightsCache.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/VlmEngine500.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/VlmManifests.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/VlmRouter.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/VlmTypes.kt
apps/mobile/android/app/src/main/java/com/findback/app/vlm/WarmEngineLease.kt
```
(50 paths)

### 3b. `REMOVE-OBSOLETE` — JVM unit tests of the deleted generative runtime, 54 paths
Evidence preserved in archive `282367c`; removing them from active compilation is correct (they cannot compile once their subjects are gone). Surviving native tests: `vlm/DiagTest.kt`, `com/getcapacitor/myapp/ExampleUnitTest.java`.

```
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ActiveInferenceTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/CandidateModelStatusTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/CandidateRuntimeControllerTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ChunkManifestTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ChunkTransferEngineTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/EngineAcquireTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/EnginePolicyTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ExportSelectionPolicyTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/GenerativeResidencyArbiterTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/GpuProbeTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ImagePreparerTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ImportCommitPolicyTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ImportedModelRegistryTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/InferenceEventsTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/InferenceMutexTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/InspectedProbeClassifierTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/KnownPackageIdentityTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/LocalVlmPluginEngineLifecycleTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/LocalVlmPluginTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ModelDownloadSchedulerTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ModelDownloaderTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ModelInstallPolicyTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ModelStoreConvergenceTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ModelStoreTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ModelStoreTransferFilesTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/PackageCommitterTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/PackageHostTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/PackageInspectionKnownUnknownTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/PackageInspectionStoreTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/PinnedModelSourcesTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/PluginInitStructureTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ProbeOutcomeTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/ProgressThrottlerTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/QwenLifecycleTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/QwenTextEngineTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/QwenTextRuntimeTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/RestoredStateValidationTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/SelfTestTaxonomyTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/Sha256Test.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/SixModelRoundTripTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/StagingRecoveryTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/TestFixtures.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/TextRuntimeControllerTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/TextTransferStateTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/TransferJournalTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/TransferReconcileTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/TransferRetryPolicyTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/UnknownImportAtomicityTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/VerifiedBytesTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/VlmManifestsTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/VlmRouterTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/VlmTypesTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/WarmEngineLeaseTest.kt
apps/mobile/android/app/src/test/java/com/findback/app/vlm/WeightHashCacheTest.kt
```
(54 paths)

### 3c. `UNCERTAIN` — component tests deleted while the component survives, 2 paths

| Path | Git status | Class | Rationale / needed ruling |
|---|---|---|---|
| `apps/mobile/src/components/VlmSuggestions.test.tsx` | D | UNCERTAIN | The component itself survives (rewritten to cloud). These tests encoded *current* requirements that still hold (apply-to-draft, non-destructive patching). Handover rule: "preserve user-edited test cases if they still test real current requirements." New `VlmSuggestions.cloud.test.tsx` covers the photo/cloud path only. **Owner: supervisor/worker A — decide port-vs-drop.** |
| `apps/mobile/src/components/VlmSuggestions.readiness.test.tsx` | D | UNCERTAIN | Readiness gate was a local-model concept (`ImageAnalysisReadiness`) that the pivot removed from `CreateReport`, so most of this file is obsolete — but it also asserted the "suggestions never silently overwrite the draft" contract. **Owner: supervisor/worker A — confirm the overwrite-guard contract is covered elsewhere before dropping.** |

Deletion tally: 50 + 54 + 2 = **106** ✓

---

## 4. Reconciliation workflow evidence (from `02_SAFE_RECONCILIATION_AND_GIT.md`)

- Counts matched the reported **26 M / 106 D / 19 ??** exactly; nothing forced.
- `main` history: HEAD = `origin/main` = `1718d50`. Archive branch + tag both = `282367c`. No fetch/pull performed (dirty tree — correctly skipped).
- `git diff --check` → exit 0 (no conflict markers, no whitespace errors).
- Generated artifacts: none staged; no model bytes, no `.env`, no `desktop.ini`, no APK in status.
- Editor comparison (workflow step 6) → see §5.
- Safety snapshot: **not created by worker B** — out of my scope (supervisor/worker A integration step). Flagged as an open item.

## 5. Editor vs archive `282367c` — REPORT ONLY (no editor edits made)

Command: `git diff --stat 282367c -- <editor files>` plus byte-compare of untracked files via `git show 282367c:<path> | diff`.

| Editor file | vs archive `282367c` | Verdict |
|---|---|---|
| `components/RichTextEditor.tsx` | no diff | **equal** |
| `services/richText.ts` | no diff | **equal** (+50 `descriptionVisibleText`/`measureDescription` present) |
| `index.css` | no diff | **equal** (ED-01 `.tiptap` typography + `.fb-markdown` hierarchy present) |
| `components/MarkdownView.tsx` | no diff | **equal** (distinct h1/h2/h3 → h2/h3/h4 mapping present) |
| `components/RichTextEditor.test.tsx` | no diff | **equal** |
| `components/MarkdownView.test.tsx` | no diff | **equal** |
| `components/RichTextEditor.workset2.test.tsx` | no diff | **equal** |
| `components/RichTextEditor.edAudit.test.tsx` | byte-identical (untracked) | **equal** |
| `components/RichTextEditor.menus.test.tsx` | byte-identical (untracked) | **equal** |
| `screens/CreateReport.tsx` | +8 / −54 vs archive | **ahead** — every archive editor hunk retained (`measureDescription` import L11, ED-05 usage L402, contract comment L403-406, `DESCRIPTION_MAX = 3000` L42, `maxLength={DESCRIPTION_MAX}` L602). All −54 are pivot-only removals (`imageAnalysisReadiness`, `toNativeImageUri`, local-VLM suggestion gating) plus one pivot addition (AI-apply `window.confirm`). |

**Regression report: none found.** Working tree is equal-or-ahead of `282367c` on all five editor files and all five editor test files. No editor file was rewritten by worker B.

Archive-only items **not** ported (flagged, not fixed — outside worker B scope):
- `components/VlmSuggestions.ux01.test.tsx` (added in archive, absent from worktree) — owner worker A/supervisor.
- `components/ModelManagerView.test.tsx` (modified in archive) — local model manager, obsolete under the pivot; owner supervisor.

## 6. Free-only scan (equivalent of `tools/verify_free_only.mjs`) — REPORT

| Check | Result | Evidence |
|---|---|---|
| `openrouter/auto` in non-test sources | **0 hits** ✅ | `rg 'openrouter/auto' apps/mobile/src services/api/src supabase/functions .github/workflows` excluding `*.test.*`/`*.spec.*` → exit 1 (no match). Sole occurrences are smuggle-test vectors in `services/openRouter.test.ts`. |
| `openrouter/free` present (free router literal) | **1 hit** ✅ | `apps/mobile/src/services/openRouter.ts:5: export const OPENROUTER_MODEL = "openrouter/free" as const;` (the script's `!matches.length → exit 1` guard therefore passes) |
| No paid model IDs in shipped route | **FAIL** ❌ | `supabase/functions/ai-help/index.ts:79` default `"gpt-4o-mini"`; `services/api/src/config.ts:77` default `"deepseek-chat"` — see defect `WB-02`. |
| No `LLM_MODEL` / `LLM_BASE_URL` second route | **FAIL** ❌ | 4 hits: `supabase/functions/ai-help/index.ts:77,79`, `services/api/src/config.ts:75,77` — see defect `WB-02`. Client `askAiHelp` no longer invokes it (owner: worker A), but the server route still exists. |
| No embedded OpenRouter key config | **0 hits** ✅ | `rg 'VITE_OPENROUTER_API_KEY\|OPENROUTER_API_KEY\s*[:=]'` over `apps/mobile/src services/api/src supabase/functions .github/workflows` → exit 1. |
| No `sk-or` secrets in source | **0 real secrets** ✅ | Only `apps/mobile/src/screens/AiConnection.test.tsx:52,55` — `sk-or-v1-abcdefgh1234`, an obviously-fake placeholder used to assert the key is *never rendered*. No `.env`, token or real key in any source/diff. |
| Old local-generative reachability (script's review list) | **hits present** ⚠️ | `LocalVlmPlugin`: only in *comments* of `services/models/textRuntime.ts`, `modelActivation.ts`, `runtimeAdapters.ts`. `OfflineAiCompact`: `screens/OfflineAiCompact.tsx` still exists and imports `getVlmBridge` (route removed by `App.tsx`, so unreachable but still compiled). `VlmSuggestions`: current cloud component (intended). See defects `WB-03`/`WB-04`. |

**Verdict: the scan is NOT clean.** 2 hard findings (WB-02 second server route with paid defaults; WB-03/04 residual local-generative TS + stale proguard) plus 1 contract finding (WB-01 PossibleMatches seam, fixed by worker B).

## 7. Hidden generated files / Drive artifacts

- No `desktop.ini` in the repo tree.
- `tmp-10l-rt.mjs` at repo root is **gitignored** (`.gitignore:50 tmp-*.mjs`) and absent from status; it is a scratch Supabase script and must never be staged. Contains no key literal (reads `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` from env + `/tmp/opencode/10l-user2.json`). Not part of the 151-path inventory.
- No build outputs, model weights or APKs appear in status.

## 8. Changed outside expected scope

Nothing outside the pivot's declared areas. Note the deliberate overlaps already assigned:
- `apps/mobile/android/.../MainActivity.java` also gained `OpenRouterKeyPlugin` (pivot) — native + pivot overlap, coherent.
- `apps/mobile/src/services/auth.ts` `askAiHelp` now OpenRouter-backed — worker A scope.

## 9. Conflicts / resolutions

No merge conflicts, no conflict markers (`git diff --check` clean).

## 10. Current risk before committing

1. **P1 contract gap fixed by worker B:** unvalidated embedding vectors could fabricate `available: true` matches — see defect `WB-01` and §3 of `pivot-worker-b.log.md`.
2. **P2:** server-side `LLM_MODEL`/`LLM_BASE_URL` route with paid defaults still shipped (`WB-02`).
3. **P2:** full local-generative TS layer (`services/models/*`, `vlmPlugin.ts`, `OfflineAiCompact.tsx`, `ModelManagerView.tsx`, `vlmDiscovery.ts`, …) is still tracked-and-unchanged in the tree; only the native half was pruned (`WB-03`).
4. **P3:** `apps/mobile/android/app/proguard-rules.pro` still `-keep`s deleted classes `LocalVlmPlugin`, `ModelDownloadJobService`, `ModelStateRecord`, `VlmModelId`, … (file unchanged, not in inventory) (`WB-04`).
5. **P3:** no JVM test for `EmbeddingPlugin`/`UniversalSentenceEmbedder` isolation — only `DiagTest.kt` survives (`WB-05`).
6. **P3:** two component tests deleted with coverage not clearly replaced (`WB-06`, §3c UNCERTAIN).
7. Local-only safety snapshot (`02_SAFE_RECONCILIATION_AND_GIT.md` §"snapshot") has **not** been taken yet.
8. No test/lint/typecheck of the integrated tree has been run by worker B beyond focused embeddings/possibleMatches vitest + typecheck under `heavy.lock`.

---

## WB-02 disposition — mobile-side absence proof (worker W4, 2026-09-25)

Scope of this section only: **WB-02** (legacy `ai-help` Edge route + `LLM_MODEL`/`LLM_BASE_URL`
second route + paid model defaults). No other section, row or file of this document was changed.
Server files (`supabase/functions/**`, `services/api/**`) were **not** edited — owner deployment
decision pending.

### Client half — PROVEN CLEAN

| Check (over `apps/mobile/src`) | Result | Evidence |
|---|---|---|
| Active call to legacy `functions/v1/ai-help` | **0 hits** ✅ | `rg -n 'functions/v1/ai-help' apps/mobile/src` → exit 1 |
| `.invoke("ai-help")` / any `functions.invoke` of `ai-help` | **0 hits** ✅ | `rg -n 'functions\.invoke\|\.invoke\('` → only `auth.test.ts` mock resets + `not.toHaveBeenCalled()` negative assertions |
| `LLM_MODEL` / `LLM_BASE_URL` | **0 hits** ✅ | `rg -n 'LLM_MODEL\|LLM_BASE_URL' apps/mobile/src` → exit 1 |
| Paid model IDs (`openai/`, `anthropic/`, `deepseek/`, `gpt-*`, `claude-*`, `gemini-*`, `deepseek-chat`, `command-r`, `grok-*`) | **0 hits** ✅ | `rg` over `apps/mobile/src` → exit 1 |
| `openrouter/auto` in non-test sources | **0 hits** ✅ | sole 2 hits = `services/openRouter.test.ts:19,31` contract smuggle vectors |
| `openrouter/free` pinned | **present** ✅ | `services/openRouter.ts:5` `export const OPENROUTER_MODEL = "openrouter/free" as const` |
| `VITE_OPENROUTER_API_KEY` / `OPENROUTER_API_KEY[:=]` | **0 hits** ✅ | `rg` → exit 1 |
| `sk-or-*` | **fixtures only** ✅ | 2 hits, both `screens/AiConnection.test.tsx:52,55` (`sk-or-v1-abcdefgh1234`, asserted never rendered) |
| Remaining `ai-help` mentions | **not active calls** ✅ | `services/appCapabilities.ts:7-8` = JSDoc comment; `services/appCapabilities.test.ts:11` = test-time `readFileSync` of the edge source for version parity (no network, no URL) → tracked as `WB-08` |

**Verdict: the mobile app makes ZERO active calls to the legacy `ai-help` Edge path.** [VERIFIED]

### New regression guard (file added by W4)

`apps/mobile/src/services/noLegacyAiRoute.test.ts` — static, CI-safe (no network/key/build):
comment-stripped source-scan of `apps/mobile/src` **plus** an independent import graph from
`main.tsx`. Shipped modules must contain no `ai-help`, `functions/v1`, `LLM_MODEL`, `LLM_BASE_URL`,
non-free `openrouter/…` route, vendor-qualified or bare paid model ID, `sk-or-*`, `VITE_OPENROUTER_API_KEY`
or `api/v1/byok`; `openrouter/auto` and `sk-or-*` are permitted **only** inside `*.test.*` files;
`openrouter/free` must be present (non-vacuous positive control).

Heavy evidence (`heavy.lock`, owner pivot-w4, acquired 2026-09-25T05:32:18Z, released, `LOCK_CLEARED`):
`npx vitest run src/services/noLegacyAiRoute.test.ts` → **1 test file passed, 7 tests passed, 0 failed,
VITEST_EXIT=0**; `npm run build -w packages/shared` → exit 0.

### Server half — unchanged, owner decision pending (WB-02 stays OPEN)

Re-read-only confirmation, no edits: `supabase/functions/ai-help/index.ts:77` `LLM_BASE_URL`,
`:79` `LLM_MODEL ?? "gpt-4o-mini"`; `services/api/src/config.ts:75` `LLM_BASE_URL`,
`:77` `LLM_MODEL ?? "deepseek-chat"`. Rows **252-253 of §6 stay as FAIL** and the WB-02 defect row
in `DEFECT_REGISTER.csv` stays **OPEN** — only the *client* half is now proven and guarded.

### Free-only scan (handover tool copy, not in repo)

`node /tmp/opencode/handover/FindBack_OpenRouter_Pivot_Handover_2026-09-25/tools/verify_free_only.mjs /home/sheikh/GitHub/FindBack`
→ **FREEONLY_EXIT=0** (note: `tools/verify_free_only.mjs` does not exist in the repo tree —
`tools/` holds only `render_erd.py`; the handover copy was used and no tool file was added).
Output: `Files with openrouter/free literal: apps/mobile/src/services/openRouter.ts`;
`Potential violations/review items: 4` (was 8 at §6 time) — `VlmSuggestions.tsx` +
`CreateReport.tsx` (old local-generative reachability, `WB-03`), `services/api/src/config.ts` +
`supabase/functions/ai-help/index.ts` (**WB-02 server route**). `openrouter/auto` FORBIDDEN = 0,
`VITE_OPENROUTER_API_KEY` key-config = 0.

### Rows appended to `templates/DEFECT_REGISTER.csv` (new only)

- **WB-07** P3 `DEFECT_FIXED` (worker W4) — no static guard existed against legacy `ai-help`/paid-ID
  literals in mobile sources; fixed by `noLegacyAiRoute.test.ts`.
- **WB-08** P3 `GAP` (unassigned — supervisor) — `appCapabilities.test.ts:11` still reads
  `supabase/functions/ai-help/capabilities.ts` at test time; breaks if the owner retires the function.
