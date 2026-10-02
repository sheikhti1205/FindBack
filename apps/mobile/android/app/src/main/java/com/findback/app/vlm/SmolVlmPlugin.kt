package com.findback.app.vlm

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * WS3 skeleton: SmolVLM2-500M LiteRT bridge stub (comment-only, no inference yet).
 *
 * This plugin will be the TypeScript `OfflineNativeBridge` vision counterpart
 * once the follow-up native worker lands the LiteRT integration. Until then
 * every entry point rejects with `vision_unsupported` so the TS adapter's
 * explicit `unavailable` / `no-fallback` verdict stays truthful end to end:
 * unavailable here is a typed refusal, never a silent cloud retry.
 *
 * Intended surface (NOT implemented here — listed so the worker does not
 * renegotiate the contract):
 * - `isVisionAvailable()` -> whether an image-capable resident is loaded.
 * - `loadVisionModel()` -> resident-switch for the SmolVLM2-500M weights
 *   (evict-then-load, self-test, resolve only on READY; single-resident
 *   rule shared with the language resident, runtime-only state).
 * - `describeImage()` -> chunked vision inference as Capacitor listener
 *   events keyed by a generation id, honouring cancellation.
 * - `unloadVisionModel()` -> release the vision resident.
 *
 * Backend policy (mirrors `src/services/ai/vision/backendSelector.ts` and
 * [LiteRtBackend]): CPU-first via [VisionLanguageSplit.STABLE_DEFAULT];
 * GPU only with a fresh [GpuProbePassRecord] for that resident.
 *
 * NO NEW GRADLE DEPS YET (deliberate): the real bridge will need the LiteRT
 * artifacts (e.g. `com.google.ai.edge.litert:litert` + GPU delegate) in
 * `app/build.gradle`, the verified `.litertlm` asset wiring, and the probe
 * harness. Nothing here imports LiteRT so the skeleton compiles without
 * touching the dependency graph.
 *
 * NOTE: like `FindBackDiagPlugin`, this plugin must be registered in
 * MainActivity (outside this task's file lease) with
 * `registerPlugin(SmolVlmPlugin::class.java)` before JS can reach it.
 */
@CapacitorPlugin(name = "FindbackSmolVlm")
class SmolVlmPlugin : Plugin() {

    @PluginMethod
    fun isVisionAvailable(call: PluginCall) {
        // Skeleton: no vision resident exists yet. Report absence honestly
        // instead of resolving a fabricated capability.
        call.reject("vision_unsupported")
    }

    @PluginMethod
    fun loadVisionModel(call: PluginCall) {
        // Skeleton: no weights are bundled and no LiteRT runtime is linked.
        call.reject("vision_unsupported")
    }

    @PluginMethod
    fun describeImage(call: PluginCall) {
        // Skeleton: never accept image bytes without an inference engine
        // behind them; fail closed so callers keep the typed refusal.
        call.reject("vision_unsupported")
    }

    @PluginMethod
    fun unloadVisionModel(call: PluginCall) {
        // Nothing resident in the skeleton; resolving keeps lifecycle
        // callers (load -> unload) balanced without claiming work.
        call.resolve()
    }
}
