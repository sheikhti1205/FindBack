# Independent adversarial review — model-supply wave

- **Reviewer:** global Reviewer (read-only), model id `agentrouter/deepseek-v4-flash`.
- **Scope:** uncommitted model-supply wave in `/home/sheikh/GitHub/FindBack` on `main`, HEAD `eccd07ac893e09f9a8aa733b104943973e861486`.
- **Method:** fresh-context adversarial trace of the real production paths; no product file mutated. I did not implement this wave and did not trust the implementer summary; every claim below was re-derived from the working tree.
- **Independence caveat:** I cannot confirm the Builder's model id from this session; if it was the same model, independence here rests only on fresh context + adversarial stance (rule 4), so I applied extra rigor (re-ran tests, re-derived native signatures from vendored headers, re-computed the gate bypass).
- **Verdict:** **PARTIAL**

## What was independently verified (not just "tests were green")

- `node scripts/ai-release-gate.mjs` → PASS, all 14 checks (stale-markers, manifest-pins, license-bundle, model-notices, abi-artifacts, vision-truth, photo-analysis-truth, runtime-wiring, descriptor-registry, application-integration, endpoint-pin, needle-telemetry, promotion-policy, secrets).
- `node scripts/completion-gate.mjs` (integrity) → PASS. `--final` → correctly RED (stale waivers + BLOCKED_EXTERNAL + dirty tree), i.e. honest HOLD, matches `completion-ledger.json` `releaseStatus: HOLD`.
- `node scripts/cross-environment-closure.mjs` → OK, 18 rows; `baselineSha` = HEAD, reachable.
- Re-ran focused suites: `supply.test.ts`, `applicationAi.import.test.ts`, `modelSupply.test.ts`, `modelLicenses.test.ts`, `download/transport.test.ts` → 5 files / 56 tests pass; `node --test scripts/completion-gate.test.mjs` → 29 pass / 0 fail.
- Rendered evidence independently confirmed: `/tmp/opencode/ai-motion-evidence/results.json` = 52 scenarios across surfaces `models|advanced|motion|scrolled-motion|interrupted-motion`, widths 320/360/390, light/dark/amoled, standard/xlarge, **0 overflow / 0 doubled**. Inspected `advanced-320-light-standard.png` — renders cleanly, no overflow, bounded controls, consumer-safe copy. This substantiates the host-rendered claim (device/IME/TalkBack still owner-only).
- Failover boundary (`driver.ts:205`, `sourcePolicy.ts:12,17`): retries **only** `TIMEOUT|NETWORK_ERROR|HTTP_404|HTTP_410|HTTP_429|HTTP_5xx`; `CHECKSUM_MISMATCH|SIZE_MISMATCH|BYTE_BOUND_EXCEEDED|LICENSE_MISMATCH|MANIFEST_MISMATCH|BAD_MANIFEST|TLS_ERROR|HTTP_403` stop (driver.ts:225). Verified in `supply.test.ts:22,29,63`.
- Integrity is enforced **after** the retry loop (driver.ts:243,255,269) and inside native (`ModelDownloadPlugin.kt:466,531,532`), so a post-transfer mismatch never triggers a second source. Confirmed by reading, not by summary.
- Secret hygiene: TS error path preserves only bridge codes (`sourcePolicy.ts:17`); the native downloader never sets an `Authorization` header (`ModelDownloadPlugin.kt:415-422`); journal writes the **original** URL, not the signed redirect (`ModelDownloadPlugin.kt:533,552`); `finalUrl` is never persisted in TS (`grep finalUrl` shows only unused return + pre-existing shortlink/location code). `supply.test.ts:34` asserts the error surface contains no `secret`.
- SSRF/redirect: `instanceFollowRedirects=false`, per-hop host allow-list (`DownloadPolicy.redirectAllowed`) + DNS `publicDestination` check on every hop (`ModelDownloadPlugin.kt:414,425-440`).
- Unknown-import trust: `imported-<sha256>`, `trust:"imported"`, `maturity:"lab"`, `taskRoles:[]`, URL stripped before persist (`import.ts:12`, `applicationAi.ts:488,502`). Default vision model is pinned to the curated `SMOL_VISION_MODEL_ID` (`applicationAi.ts:204`, `modelDescriptors.ts:342`); roles derive from `taskRoles` (`uiModelRoles.ts:60`), so an import cannot be auto-selected. `applicationAi.import.test.ts:69,107` assert this.
- Native JNI/API calls match the **vendored** pinned headers: `chat.h` (`content_parts{type,text}`, `common_chat_templates_init(model,"")`, `.prompt`), `mtmd.h`/`mtmd-helper.h` (`mtmd_input_text{text,len,add_special,parse_special}`, `mtmd_helper_eval_chunks(ctx,lctx,chunks,n_past,seq_id,n_batch,logits_last,&new_n_past)`, `mtmd_support_vision`, `mtmd_bitmap_init(nx,ny,data)`, `mtmd_default_marker`). Image path fails closed when `g_vision == null` (`llama_bridge.cpp:176-179`).
- `importLocal` verifies a curated `modelId` against the catalogue pin and rejects mismatched bytes (`applicationAi.ts:543`), so filename/hash cannot escalate trust.

## Findings

### P2 — completion-gate stale-waiver protection is opt-in and silently disable-able
`scripts/completion-gate.mjs:161` (new in this wave; `git show HEAD:scripts/completion-gate.mjs` contains 0 occurrences of `candidateVersion`):
```
if (final && ledger.candidateVersion !== undefined && item?.status === WAIVED_STATUS) { ... }
```
**What is wrong:** the stale-waiver rule only fires when the ledger *declares* `candidateVersion`. `validateLedger` never requires the field. Deleting one field disables the entire new protection.
**Proof:** in-process simulation — clone the shipped ledger, close the open items, set `releaseStatus:"READY"`, drop `candidateVersion`, call `validateLedger(final:true, release:true)` → **0** stale-waiver errors (10 when the field is present). No other rule blocks it.
**Why it matters:** the documented release preflight (`docs/runbooks/cross-environment-closure.md:52-60`) runs `completion-gate.mjs --final` but **not** `node --test scripts/*.test.mjs`, and the only guard is a unit assertion on the shipped ledger (`scripts/completion-gate.test.mjs:332`). An operator following the runbook would not catch the bypass.
**Minimal fix:** in `validateLedger`, when `final && release`, require `typeof ledger.candidateVersion === "string" && ledger.candidateVersion.trim() !== ""` and push an error otherwise; keep the existing per-item mismatch check. Add a test asserting an omitted `candidateVersion` is rejected in final/release mode.

### P3 — `FindbackLlama` class doc asserts a load self-test that no longer exists
`apps/mobile/android/app/src/main/java/com/findback/app/llama/FindbackLlama.kt:29-31` claims load "proves the session with a bounded probe generation before resolving READY (a file that parses but cannot generate never reads as ready)".
**What is wrong:** the probe was removed in this wave. The inline comment at `:106` states the opposite ("Evaluation itself is the explicit self-test. Do not seed hybrid recurrent state with a hidden probe"), and `loadLlamaModel` resolves `ready:true` immediately after `nativeLoad`/`nativeLoadProjector` with no generation (`:103-117`).
**Why it matters:** the docstring overstates readiness proof for LFM2 hybrid-recurrent models and contradicts the code a reviewer/maintainer will read next.
**Minimal fix:** update the docstring to state that load performs no generation; readiness is proven only by explicit evaluation; document the recurrent-state rationale for dropping the probe.

### P3 — arbitrary imported LiteRT vision models run through the *production* SmolVLM seam
`apps/mobile/src/services/ai/download/import.ts:14` maps any imported `format:"litertlm"` + `modality:"vision"` to `runtimeId:"smolvlm2-litertlm"`, which `applicationAi.ts:611` loads via the production `this.smol.loadVisionModel(...)`. Same for `format:"cact"` → `needle-cact` (production Needle).
**What is wrong:** an uncurated file is evaluated on a production runtime rather than a lab-only runtime.
**Why it is not P1:** guarded by explicit user opt-in (`evaluate` requires `optIn`, `applicationAi.ts:586`), `trust:"imported"`, `taskRoles:[]`, default-vision pinned to the curated id, and no auto-selection; it is Advanced-only. Residual risk is in-process execution of untrusted model bytes on a production runtime.
**Minimal fix (optional/hardening):** route imported descriptors to a lab-scoped runtime id, or add an explicit "untrusted import" flag that the production seams refuse.

## Unverifiable claims / needed evidence

- **Native Android compilation, linking, JNI packaging, and on-device inference are unproven.** `llama_bridge.cpp`/`CMakeLists.txt`/`variables.gradle` were hand-checked against the vendored headers (all signatures match) but are uncompiled in this environment. Needed: `npm run apk` with `VITE_SUPABASE_URL`/`VITE_SUPABASE_PUBLISHABLE_KEY` asserted non-empty pre-build + `scripts/check-release-config.mjs`, then a device/emulator smoke of LFM2-VL/Qwen3-VL projector load + one vision evaluation.
- **Upstream pin bytes/SHA not re-fetched.** `SUPPLY_CANDIDATES` (`modelSupply.ts:47-62`) and `docs/evidence/model-license-packet.json` are internally self-consistent (every packet entry: declared `bytes` == UTF-8 length and key == recomputed SHA-256), but that proves snapshot integrity, not upstream provenance. Needed: authorized download of at least one pin per family and recompute SHA-256/bytes against the catalogue.
- **License-fact accuracy is owner-side.** `LFM_LICENSE_FACTS` (`modelSupply.ts:20`) and per-family facts were not independently validated against upstream license text.
- **Rendered evidence is host/DOM only.** Device widths at non-integer DPR, real IME, TalkBack, and full-image vision intake remain owner-device items.
- **No independent reviewer PASS existed before this file** (`docs/evidence/2026-10-14-model-supply-progress.md:7,122,172` self-labels the wave PARTIAL). This review is the first independent verdict.

## Unresolved questions / blockers

- Should LFM-licensed arms be *downloadable* at all on the advanced tier, or only importable? `license-bundle` passes because it only guards the bundle channel; owner commercial-eligibility review is still open (`model-supply-progress.md:139`).
- `docs/runbooks/cross-environment-closure.md:53` expects a clean tree; the wave cannot satisfy `completion-gate.mjs --final` head-binding until committed with a final ledger commit. Expected for in-flight work, but the runbook preflight should not be quoted as passing until then.

## Next action

Same implementer: apply the P2 gate fix (require `candidateVersion` in final/release mode) and the two P3 doc/scope fixes, add the missing gate test, then commit on `main` with the final ledger commit and arrange the Android build + device smoke. Re-review the delta, then this wave may move from PARTIAL toward PASS.

## Coordinator response (2026-10-14, delta pass)

All three findings were fixed; a delta re-review was requested.

- **P2 (gate bypass) — FIXED.** `scripts/completion-gate.mjs` now requires a non-empty
  string `candidateVersion` whenever `final || release` is set, independently of the
  per-item stale-waiver check, so the field can no longer be deleted to disable the rule.
  New test `cannot disable the stale-waiver rule by omitting candidateVersion` proves the
  omission is rejected. `validateLedger` final/release tests updated; `completion-gate.test.mjs`
  30 pass / 0 fail, and the full script suite is 444 pass / 0 fail.
- **P3 (FindbackLlama docstring) — FIXED.** The class doc now states that load performs no
  generation and that readiness is proven only by the first explicit evaluation, matching the
  inline rationale.
- **P3 (untrusted imports on production runtimes) — FIXED (flag + invariant).** `ModelDescriptor`
  gains `untrustedImport?: boolean`; `importedDescriptor` sets it. Production task backends are
  built only from curated descriptors with non-empty `taskRoles` (`applicationAi.ts:264-297`), so
  an untrusted import is structurally unroutable. A new test
  (`never registers an untrusted import as a production task backend`) asserts the invariant
  across the whole registry (`untrustedImport === true ⇒ taskRoles === []`) and asserts a
  URL-imported descriptor carries `untrustedImport: true`. Vendor-native lab-runtime separation
  remains a future hardening (not required to satisfy the P3).

Post-fix verification (heavy lock held): `npm run typecheck -w apps/mobile` clean; full mobile
suite **4902 passed / 0 failed** / 1 skipped / 3 todo (4906); `node --test scripts/*.test.mjs`
**444 passed / 0 failed**; `npm run lint` clean.

The PARTIAL→PASS blocker was named by the reviewer as the **uncompiled native Android surface**,
not a code defect; that remains owner/device work and is unchanged.

