# Model supply implementation — partial progress, 2026-10-14

## Status and acceptance boundary

**PARTIAL implementation evidence, not release/device acceptance and not an independent review.**

Work remains on `main` in `/home/sheikh/GitHub/FindBack`. No commit, push, APK/web build, model binary download, device/emulator run, third-party source edit, credential read, or release artifact was performed in this continuation. The owner-provided `2026-10-14-model-upstream-research.md` was read in full and left unchanged. No production task roles were added.

Native changes from the earlier work remain uncompiled on Android. A host C++ syntax check passed; that is **not** Android compilation, linking, JNI packaging, or inference proof. UI DOM tests passed; no rendered phone/theme/large-text/IME acceptance has been performed. The coordinator must arrange independent review; the implementer did not delegate or claim reviewer PASS.

## Changes verified in this continuation

- Added an explicitly opened Advanced panel to `AiModelsRoute`. Recommended tools remain the ordinary consumer surface. Technical IDs, hashes, sources, conditional license details, import fields and evaluation controls are absent until Advanced is opened.
- Added `AiModelsRouteAdvanced`: model choice from the canonical registry, known-file native import, explicit-metadata URL import, unknown-file imported identity, single-file same-byte mirror entry, verify/remove, evaluation prompt/opt-in, cancellation and answer/error state.
- Vision evaluation photo intake calls the existing `chooseNativeImage` pipeline. Only its bounded orientation-correct, metadata-stripped derivative is encoded for inference. Original photo bytes are not decoded into JS here. Native picker cancellation and actual full-image behavior remain device verification items.
- Fixed local and URL import rollback: failed private identity persistence removes promoted files and clears the ready claim instead of retaining a false installed state. Failed URL acquisition no longer leaves its acquisition URL in the live catalogue.
- Preserved imported trust/empty task roles and restart identity; persistence excludes the URL. Conflicting format/runtime/size/license metadata cannot overwrite an installed hash-derived import identity.
- Added operation signals for URL imports and downloads so a pre-cancelled URL operation does not start acquisition. Advanced closure/unmount aborts work and suppresses late displayed answers.
- Evaluation is refused while an import persistence transaction remains pending.
- Fixed cancellation during atomic promotion: the downloader discards a late promoted file and settles into a retryable paused state rather than remaining verifying indefinitely. CANCEL from verifying now clears `checksumVerified`; an already deleted model is not resurrected.
- Native checksum/size/byte-cap/license/manifest errors stop without failover and attempt to delete invalid staging plus journal. Returned-digest verification failure also deletes the journal.
- Updated obsolete test expectations for owner-enabled, exact-pinned Advanced acquisition and accurate conditional LFM licensing. Packaging remains blocked by FindBack policy, not a purported upstream redistribution ban. Adapter download is still not an inference/evaluation channel.
- Corrected resume fakes to return only bytes received in the resumed attempt and to supply actual identity/source journals. Existing offset assertions remain intact; they were not removed to hide failures.

## Contracts/invariants

1. Immutable artifact identity is independent of acquisition URL. Every known weight/projector has its own exact bytes/hash/revision/filename; different quantizations, stock/fixB and original/successor models are not mirrors.
2. Advanced acquisition does not change production roles, tier qualification, routing defaults, or device qualification. New candidates retain lab maturity, empty roles and empty device-qualified ABI evidence.
3. Unknown imports retain `imported-<sha256>` identity, imported trust and empty roles after restart. A supplied filename or a matching curated model hash cannot promote trust.
4. Initial public HTTPS sources reject credentials/token queries. Signed redirects remain ephemeral. Native structured codes are preserved without exposing raw source/error URLs.
5. Eligible network/HTTP failover is bounded. Integrity/license/manifest/TLS/auth failures do not silently try different bytes.
6. Known multimodal bundles are not ready until all files pass verification and the bundle directory is promoted. Source switching clears partials/journals.
7. Explicit evaluation uses the canonical residency owner, releases its engine afterward, does not display reasoning channels and requires user opt-in. Native cancellation/settlement and fresh-engine isolation still need Android evidence.
8. Persistence failure must not leave a ready claim referring to deleted files. In-memory operation guards prevent evaluation of an incompletely persisted import.

## File inventory

### Added source/tests in the worktree

- `apps/mobile/src/screens/AiModelsRouteAdvanced.tsx`
- `apps/mobile/src/screens/AiModelsRouteAdvanced.test.tsx`
- `apps/mobile/src/services/ai/applicationAi.import.test.ts`
- `apps/mobile/src/services/ai/applicationAi.supply.test.ts`
- `apps/mobile/src/services/ai/modelSupply.ts`
- `apps/mobile/src/services/ai/modelSupply.test.ts`
- `apps/mobile/src/services/ai/download/sourcePolicy.ts`
- `apps/mobile/src/services/ai/download/import.ts`
- `apps/mobile/src/services/ai/download/import.test.ts`
- `apps/mobile/src/services/ai/download/bundle.ts`
- `apps/mobile/src/services/ai/download/bundle.test.ts`
- `apps/mobile/src/services/ai/download/supply.test.ts`
- `apps/mobile/android/app/src/main/java/com/findback/app/ai/LiteRtArtifactPolicy.kt`
- This progress evidence file.

### Modified source/tests in the worktree

- `apps/mobile/src/screens/AiModelsRoute.tsx`, `AiModelsRoute.test.tsx`
- `apps/mobile/src/services/ai/applicationAi.ts`, `applicationAi.qwen.test.ts`
- `apps/mobile/src/services/ai/modelDescriptors.ts`, `modelDescriptors.test.ts`, `modelProfiles.ts`, `offlineModelManager.ts`
- `apps/mobile/src/services/ai/download/driver.ts`, `driver.test.ts`
- `apps/mobile/src/services/ai/llama/adapter.ts`, `licenseGate.ts`, `licenseGate.test.ts`
- `apps/mobile/src/services/ai/providers/offline.ts`, `text/litertLmText.ts`, `vision/native.ts`
- `apps/mobile/android/variables.gradle`
- `apps/mobile/android/app/src/main/cpp/CMakeLists.txt`, `llama/llama_bridge.cpp`
- `apps/mobile/android/app/src/main/java/com/findback/app/ai/QwenTextPlugin.kt`
- `apps/mobile/android/app/src/main/java/com/findback/app/download/DownloadPolicy.kt`, `ModelDownloadPlugin.kt`
- `apps/mobile/android/app/src/main/java/com/findback/app/llama/FindbackLlama.kt`, `LlamaBridge.kt`
- `apps/mobile/android/app/src/main/java/com/findback/app/vlm/SmolVlmPlugin.kt`

The separate untracked upstream research file existed before this implementation and is not an implementation-generated change.

## Unified-diff summary

- Descriptor catalogue: replaces pending/fictitious Advanced pins with explicit genuine artifact identities; separates Advanced acquisition from production routing. Existing Needle, SmolVLM2 and Qwen 0.6B byte identities remain.
- Download driver/state machine: adds bounded exact-byte source selection, source-aware resume, terminal invalid-byte cleanup and cancellation-safe promotion.
- Application owner: adds imports and explicit evaluation through canonical storage/registry/residency seams; makes persistence transactional at the readiness boundary and propagates acquisition cancellation.
- Route: replaces the always-visible Advanced candidate card list with a deliberate Advanced disclosure and one selected-model workflow.
- Android source: adds streaming SAF/private metadata/network policy, LiteRT 0.18 metadata checks/evaluation flags and llama common-template/mtmd image JNI support. These are source changes, not Android-verified functionality.

## Exact final verification commands and results

Working directory for the following chained command: `/home/sheikh/GitHub/FindBack/apps/mobile`.

```bash
npm run typecheck && npx vitest run src/services/ai/applicationAi.import.test.ts src/services/ai/applicationAi.supply.test.ts src/services/ai/applicationAi.qwen.test.ts src/services/ai/download/supply.test.ts src/services/ai/download/import.test.ts src/services/ai/download/bundle.test.ts src/services/ai/download/driver.test.ts src/services/ai/modelSupply.test.ts src/services/ai/modelDescriptors.test.ts src/services/ai/modelProfiles.test.ts src/services/ai/llama/licenseGate.test.ts src/services/ai/offline.test.ts src/screens/AiModelsRoute.test.tsx src/screens/AiModelsRouteAdvanced.test.tsx --maxWorkers=1 && npx eslint src/services/ai/applicationAi.ts src/services/ai/applicationAi.import.test.ts src/services/ai/applicationAi.supply.test.ts src/services/ai/applicationAi.qwen.test.ts src/services/ai/download/driver.ts src/services/ai/download/driver.test.ts src/services/ai/download/sourcePolicy.ts src/services/ai/download/supply.test.ts src/services/ai/download/import.ts src/services/ai/download/import.test.ts src/services/ai/download/bundle.ts src/services/ai/download/bundle.test.ts src/services/ai/modelSupply.ts src/services/ai/modelSupply.test.ts src/services/ai/modelDescriptors.ts src/services/ai/modelDescriptors.test.ts src/services/ai/modelProfiles.ts src/services/ai/offlineModelManager.ts src/services/ai/llama/adapter.ts src/services/ai/llama/licenseGate.ts src/services/ai/llama/licenseGate.test.ts src/services/ai/providers/offline.ts src/services/ai/text/litertLmText.ts src/services/ai/vision/native.ts src/screens/AiModelsRoute.tsx src/screens/AiModelsRoute.test.tsx src/screens/AiModelsRouteAdvanced.tsx src/screens/AiModelsRouteAdvanced.test.tsx
```

**Result:** exit 0. Typecheck passed; 14 focused test files / 137 tests passed; focused ESLint passed with no diagnostics. Final test run started 21:27:14, duration 8.81s. This is not the full mobile test suite or full-project lint.

Working directory for the following command: `/home/sheikh/GitHub/FindBack`.

```bash
g++ -std=c++17 -fsyntax-only -I/usr/lib/jvm/java-21-openjdk-amd64/include -I/usr/lib/jvm/java-21-openjdk-amd64/include/linux -Iapps/mobile/android/app/src/main/cpp/third_party/llama.cpp/include -Iapps/mobile/android/app/src/main/cpp/third_party/llama.cpp/ggml/include -Iapps/mobile/android/app/src/main/cpp/third_party/llama.cpp/common -Iapps/mobile/android/app/src/main/cpp/third_party/llama.cpp/vendor -Iapps/mobile/android/app/src/main/cpp/third_party/llama.cpp/tools/mtmd apps/mobile/android/app/src/main/cpp/llama/llama_bridge.cpp && git diff --check && git status --short
```

**Result:** exit 0; host C++ syntax and tracked diff whitespace passed. Status contained only the listed source/test changes plus the pre-existing upstream research file at that point. This evidence file was added afterward.

### TDD/reproduction commands in this continuation

All commands below ran from `apps/mobile`; each used `--maxWorkers=1`.

| Exact test command | Observed evidence |
|---|---|
| `npx vitest run src/services/ai/applicationAi.import.test.ts --maxWorkers=1` | Initial 4 failures/1 pass proved false readiness after persistence failure, retained failed URL source, leftover URL install and identity overwrite. Later pre-abort test was also observed RED. All covered by final GREEN run. |
| `npx vitest run src/services/ai/download/supply.test.ts src/services/ai/applicationAi.import.test.ts --maxWorkers=1` | 2 failures/19 passes: verifying cancellation stuck and evaluation allowed during persistence. Final GREEN covers both fixes. |
| `npx vitest run src/services/ai/download/supply.test.ts src/services/ai/download/driver.test.ts --maxWorkers=1` | 5 newly added invalid-byte cleanup cases RED; resume fakes then passed with preserved offset assertions. |
| `npx vitest run src/services/ai/download/supply.test.ts --maxWorkers=1` | 6 cleanup failures/15 passes, including returned-digest journal retention; final GREEN covers fixes. |
| `npx vitest run src/screens/AiModelsRouteAdvanced.test.tsx --maxWorkers=1` | Initial absent module, then 3 behavior failures against a null skeleton; later 3 GREEN. Subsequent failed-download presentation test observed RED; final 4 GREEN. |
| `npx vitest run src/screens/AiModelsRoute.test.tsx --maxWorkers=1` | 10 RED before disclosure integration: technical copy leaked to ordinary tier and Open Advanced absent. Final 10 GREEN. |
| `npx vitest run src/services/ai/modelDescriptors.test.ts src/services/ai/modelProfiles.test.ts src/services/ai/llama/licenseGate.test.ts src/services/ai/applicationAi.qwen.test.ts --maxWorkers=1` | 5 stale policy-expectation failures/40 passes; explicit pin/role/license channel expectations updated, then 45 GREEN. |

The final aggregated run earlier exposed two resume-fixture failures (128 passes/2 failures); correcting partial-byte accounting—not relaxing the exact-byte gate—resolved them.

## Required remaining work / next action

1. **Native verification:** compile Kotlin plugins and arm64 JNI/CMake linkage, resolve/check LiteRT 0.18 dependency graph, AAR minSdk/ABI/16KiB packaging, metadata API behavior, reasoning channels, Unicode and cancellation/drain/fresh-engine isolation. Host syntax check does not cover any of these.
2. **License compliance:** add exact same-repository license text snapshots and applicable attribution/NOTICE packet. Accurate labels/disclosure do not by themselves satisfy redistribution obligations. Complete owner commercial-eligibility/legal review where applicable.
3. **Gate/runbook migration:** update and test native/model/release gates and stale benchmark catalogue provenance/policy; those changes were not made in this continuation. Do not write completion ledgers or claim an accepted release.
4. **Source matrix:** complete per-artifact acquired-byte/build evidence and independent mirror policy. The panel exposes a single-file mirror only; multimodal mirror propagation/configuration still needs work. HF aliases are not an independent outage solution.
5. **Lifecycle counterexamples:** expand native SAF invalid-format/free-space/hash/size cleanup, abort while picker open, delete during transfer/promotion/import, duplicate acquisition/account-reset, rollback cleanup failures, bundle projector corruption and restart/resume coverage. Unknown LiteRT vision imports currently have no explicit vision-runtime metadata choice in the UI; do not imply support for that path.
6. **Rendered UI acceptance:** representative 320dp/phone widths, light/dark/true-black, large text, disabled/loading/error/empty/success, focus/keyboard/IME and touch. DOM tests are necessary but not sufficient. Native photo preparation/full-image ruler/stock-versus-fixB results remain owner-device items.
7. **Independent review:** coordinator read-only reviewer must trace the actual diff and production paths and return PASS/PARTIAL/FAIL before any wave-complete claim. No reviewer PASS exists yet.

Build/artifact work must first receive the required coordinator authorization, use the canonical heavy-operation lock, assert nonempty public Supabase build variables without logging them, and perform post-build release-config verification. No such build was attempted here. The full Wave A objective remains unfinished.

## Coordinator continuation status (2026-10-14, later pass)

This section records what the coordinator closed after the partial builder pass above and what
remains. It is still **not** an independent review and **not** release/device acceptance.

### Closed since the builder pass

- **Native verification (previous item 1):** `scripts/ai-host-verify.mjs --native` PASS — Kotlin
  compile, arm64 CMake/JNI link, unit tests, dependency insights (3 BUILD SUCCESSFUL); LiteRT-LM
  `0.18.0` and coroutines `1.11.0` resolved. Web lane `--web` PASS (Vite dist built). See the
  script for the exact commands.
- **License compliance (previous item 2):** `docs/evidence/model-license-packet.json` pins each
  model's exact license and publisher-card SHA-256 (no redistribution bytes modified);
  `scripts/check-model-notices.mjs` PASS. Owner commercial-eligibility review is still owner-side
  for any shipped redistribution.
- **Gate/runbook migration (previous item 3):** `check-ai-manifest` (7 pinned profiles),
  `check-ai-promotion`, `ai-release-gate` (all 14 checks) and `check-model-notices` PASS.
- **Source matrix / mirror (previous item 4):** per-artifact same-byte mirrors implemented and
  tested (`modelSupply.ts` `validateArtifactMirrors`/`sourcesFor`; `download/bundle.ts`
  `runManagedBundle(mirrors)`), including a distinct same-byte mirror per bundle artifact
  (`bundle.test.ts`). Cross-environment matrix rebaselined to `eccd07a` with `LIVE_DATABASE` and
  `EDGE_FUNCTIONS` corrected to `READY_FOR_RUNTIME_PROOF` (were stale `PASS`).
- **Unknown-import vision choice (previous item 5):** the Advanced panel exposes an explicit
  `litertlm:vision` vs `litertlm:text`/`gguf:text` format+modality choice for unknown imports;
  no vision support is implied for unknown files beyond that explicit selection.
- **Rendered review (previous item 6, partial):** `scripts/ui-review/check-ai-motion.py` now also
  renders the production `AdvancedModelSupply` at 320/360/390 × light/dark/amoled ×
  standard/125% — 52 scenarios PASS with no horizontal overflow and no doubled flow heights
  (evidence incl. `advanced-*.png`). Physical-device/IME/TalkBack/full-image behaviour remains
  owner-device.

### Verification commands and results (this pass)

All run under the canonical heavy lock (`00_CONTROL/locks/heavy.lock`).

| Command | Result |
|---|---|
| `npm run typecheck -w apps/mobile` | exit 0 |
| `npm test -w apps/mobile` | 427 files passed / 1 skipped (428); 4901 passed / 0 failed / 1 skipped / 3 todo (4905) |
| `node --test scripts/*.test.mjs` | 443 passed / 0 failed |
| `npm run lint` | exit 0 (added `AbortSignal`/`TextDecoder`/`structuredClone` to script globals) |
| `check-ai-manifest` / `check-ai-promotion` / `ai-release-gate` / `check-model-notices` | PASS |
| `python3 scripts/ui-review/check-ai-motion.py` | PASS: 52 rendered scenarios |

### Still open after this pass

- **Independent adversarial review (previous item 7):** no reviewer PASS exists for this wave yet.
- **Commit/reconcile:** the wave is uncommitted; `completion-ledger.json` is bound to the 2.0
  candidate with legacy waivers mechanically marked stale for the candidate and `FBA-007`/`FBA-022`
  reclassified `BLOCKED_EXTERNAL`; ledger `generatedFor` must be reconciled to the final commit.
- **Device/emulator:** no attached device or AVD in the agent environment (owner-owned).
- **Release:** `2.0.0-beta.1` stays untagged and on HOLD.

