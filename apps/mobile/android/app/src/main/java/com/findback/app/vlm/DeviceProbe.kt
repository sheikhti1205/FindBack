package com.findback.app.vlm

/**
 * WS5 device-probe stub: timing-record schema for measured Automatic mode.
 *
 * Skeleton only — the native worker fills in real measurements later. The
 * TypeScript side owns selection in
 * `src/services/ai/deviceProbe.ts` / `automaticMode.ts`; this file mirrors
 * the record shape so the bridge contract stays fixed.
 *
 * Privacy boundary: collection here may use ONLY public, non-privileged
 * device facts (`android.os.Build` fields, total RAM via the public
 * `ActivityManager.MemoryInfo` API, `Build.VERSION.RELEASE`). No privileged
 * device identifiers (IMEI, serial, MAC, advertising ID), no telephony or
 * accounts APIs, no location. Identity fields travel as record-keeping
 * only and MUST NOT influence backend selection (no SoC-name guessing).
 */
object DeviceProbe {
    /** Probe schema version. Must match TS `PROBE_VERSION`. */
    const val PROBE_VERSION = 1

    /** Backends the probe may sample. `CPU` is the safe fallback. */
    const val BACKEND_CPU = "cpu"
    const val BACKEND_GPU = "gpu"
    const val BACKEND_NNAPI = "nnapi"

    /**
     * Single measured timing sample for one (model revision, backend) pair.
     * Field-for-field mirror of the TS `ProbeRecord`.
     */
    data class Record(
        val socModel: String,
        val gpuInfo: String,
        val ramMb: Long,
        val osVersion: String,
        val backend: String,
        val ttftMs: Double,
        val tokensPerSec: Double,
        val corpusVersion: String,
        val probeVersion: Int = PROBE_VERSION,
        val modelRev: String,
        val correctnessPass: Boolean
    )

    /**
     * Pure staleness gate mirroring TS `isProbeStale`: true when ANY of
     * model revision, backend, probe schema, or corpus version differs.
     * A stale record must be re-measured, never auto-preferred.
     */
    fun isStale(
        record: Record,
        modelRev: String,
        backend: String,
        probeVersion: Int = PROBE_VERSION,
        corpusVersion: String
    ): Boolean {
        return record.modelRev != modelRev ||
            record.backend != backend ||
            record.probeVersion != probeVersion ||
            record.corpusVersion != corpusVersion
    }

    /**
     * Collection entry point (NOT YET IMPLEMENTED — returns null).
     *
     * The native worker implements this later using only the public APIs
     * named in the file header: `Build.SOC_MODEL` (API 31+, else
     * `Build.HARDWARE`), renderer via the standard `GLES20.glGetString`
     * surface, total RAM via `ActivityManager.MemoryInfo.totalMem`, and
     * `Build.VERSION.RELEASE`. Timing fields come from running the
     * benchmark-corpus spot-check on the given backend; `correctnessPass`
     * records whether that spot-check passed.
     */
    fun collect(
        backend: String,
        modelRev: String,
        corpusVersion: String
    ): Record? {
        // Skeleton: no measurement yet. Returning null forces the TS-side
        // `selectBackend` no-probe path (serve cpu, schedule a probe).
        return null
    }
}
