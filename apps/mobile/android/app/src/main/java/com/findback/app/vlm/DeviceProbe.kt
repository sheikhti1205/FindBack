package com.findback.app.vlm

import android.app.ActivityManager
import android.content.Context
import android.opengl.EGL14
import android.opengl.GLES20
import android.os.Build
import android.util.Log

/**
 * On-device probe: public hardware facts + (when a timing runner is
 * present) a measured timing sample for one (model revision, backend) pair.
 *
 * Two entry points:
 * - [collectFacts] executes entirely from public, non-privileged Android
 *   APIs (`Build` fields, `ActivityManager.MemoryInfo`, headless EGL
 *   `GLES20.glGetString`, `PackageManager` Vulkan feature level, and the
 *   dlopen-only [NativeProbe] NNAPI/Vulkan/OpenCL statuses). It never
 *   returns null for missing drivers — absence is recorded as
 *   `"unknown…"` / `"unavailable…"` evidence, never fabricated success.
 * - [collect] additionally requires a [TimingRunner] (the benchmark-corpus
 *   spot-check on the given backend, wired by the benchmark workstream).
 *   Without timing there is no measured sample, so it returns null and the
 *   TS-side `selectBackend` no-probe path applies (serve cpu, schedule a
 *   probe). Identity-signal failures never fail collection; only
 *   unreadable RAM, a throwing runner, or blank arguments do.
 *
 * Privacy boundary: public facts only. No privileged identifiers (IMEI,
 * serial, MAC, advertising ID), no telephony or accounts APIs, no
 * location. Identity fields are record-keeping only and MUST NOT
 * influence backend selection (no SoC-name guessing) — selection owns
 * that rule in TS `automaticMode.ts`.
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

    /** Public device facts: the identity half of [Record], without timing. */
    data class DeviceFacts(
        val socModel: String,
        val gpuInfo: String,
        val ramMb: Long,
        val osVersion: String,
        /** NNAPI enumeration status (`supported:<n>:…` / `unavailable…`). */
        val nnapiStatus: String,
        /** Vulkan capability summary (`ok:<n>:…` / `no-lib` / …). */
        val vulkanStatus: String,
        /** OpenCL availability (`available:<n>:…` / `unavailable`). */
        val openClStatus: String,
    )

    /** One corpus spot-check run on the requested backend. */
    data class TimingResult(
        val ttftMs: Double,
        val tokensPerSec: Double,
        val correctnessPass: Boolean,
    )

    /**
     * Phase A (Step 9): discriminated benchmark failure. Each cause maps to
     * one plugin reject code — never collapsed into a single
     * `timing_unavailable`.
     */
    enum class BenchmarkFailure {
        UNKNOWN_BACKEND,
        MODEL_MISSING_OR_UNVERIFIED,
        ENGINE_INIT_FAILED,
        INFERENCE_TIMEOUT,
        COUNTERS_UNAVAILABLE,
        COUNTERS_INVALID,
        FACTS_UNREADABLE,
        NO_TIMING_RUNNER,
    }

    sealed interface BenchmarkOutcome {
        data class Success(val result: TimingResult) : BenchmarkOutcome
        data class Failure(val reason: BenchmarkFailure, val detail: String) : BenchmarkOutcome
    }

    sealed interface ProbeOutcome {
        data class Measured(val record: Record) : ProbeOutcome
        data class Failed(val reason: BenchmarkFailure, val detail: String) : ProbeOutcome
    }

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

    /** Injectable seams: tests use fakes; production uses [RealProviders]. */
    interface SocInfoProvider {
        fun socModel(): String
        fun osVersion(): String
    }

    interface RamProvider {
        fun totalRamMb(): Long
    }

    interface GpuInfoProvider {
        /** Short renderer summary, e.g. `"Adreno 750 (OpenGL ES 3.2)"`. */
        fun rendererSummary(): String
    }

    interface NnapiProbe {
        fun status(): String
    }

    interface VulkanProbe {
        fun status(): String
    }

    interface OpenClProbe {
        fun status(): String
    }

    interface TimingRunner {
        /** Null when the spot-check cannot run (weights/runtime absent). */
        fun run(backend: String): TimingResult?

        /**
         * Discriminated variant of [run]. Default bridges legacy runners:
         * success passes through, null collapses to COUNTERS_UNAVAILABLE,
         * throws to ENGINE_INIT_FAILED. Runners with first-hand knowledge
         * (RuntimeTimingRunner) override with precise reasons.
         */
        fun runDetailed(backend: String): BenchmarkOutcome {
            val result = try {
                run(backend)
            } catch (_: Exception) {
                return BenchmarkOutcome.Failure(BenchmarkFailure.ENGINE_INIT_FAILED, "timing runner threw")
            }
            return result?.let { BenchmarkOutcome.Success(it) }
                ?: BenchmarkOutcome.Failure(BenchmarkFailure.COUNTERS_UNAVAILABLE, "no timing sample")
        }
    }

    interface Deps {
        fun soc(): SocInfoProvider
        fun ram(): RamProvider
        fun gpu(): GpuInfoProvider
        fun nnapi(): NnapiProbe
        fun vulkan(): VulkanProbe
        fun openCl(): OpenClProbe
        /** Null only on test/platform dependencies without an inference runtime. */
        fun timing(): TimingRunner?
    }

    /**
     * Production providers bound to [context] (application context). All
     * identity signals degrade to `"unknown…"` fallbacks; they never throw
     * out of collection.
     */
    class RealProviders(private val context: Context) : Deps {
        private val appContext = context.applicationContext

        override fun soc(): SocInfoProvider = object : SocInfoProvider {
            override fun socModel(): String {
                if (Build.VERSION.SDK_INT >= 31) {
                    val soc = Build.SOC_MODEL
                    if (!soc.isNullOrBlank() && !soc.startsWith("unknown", true)) return soc
                }
                return Build.HARDWARE?.takeIf { it.isNotBlank() } ?: "unknown"
            }

            override fun osVersion(): String =
                Build.VERSION.RELEASE?.takeIf { it.isNotBlank() } ?: "unknown"
        }

        override fun ram(): RamProvider = object : RamProvider {
            override fun totalRamMb(): Long {
                return try {
                    val am = appContext.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
                    val info = ActivityManager.MemoryInfo()
                    am.getMemoryInfo(info)
                    info.totalMem / (1024L * 1024L)
                } catch (_: Exception) {
                    -1L
                }
            }
        }

        override fun gpu(): GpuInfoProvider = object : GpuInfoProvider {
            override fun rendererSummary(): String = readGlRenderer() ?: "unknown (egl)"
        }

        override fun nnapi(): NnapiProbe = object : NnapiProbe {
            override fun status(): String {
                if (Build.VERSION.SDK_INT < 29) return "unsupported-sdk"
                if (!NativeProbe.available) return "unavailable-no-lib"
                return try {
                    NativeProbe.nativeNnapiStatus()
                } catch (_: Exception) {
                    "unavailable-error"
                }
            }
        }

        override fun vulkan(): VulkanProbe = object : VulkanProbe {
            override fun status(): String {
                if (!NativeProbe.available) return "unavailable-no-lib"
                return try {
                    NativeProbe.nativeVulkanStatus()
                } catch (_: Exception) {
                    "unavailable-error"
                }
            }
        }

        override fun openCl(): OpenClProbe = object : OpenClProbe {
            override fun status(): String {
                if (!NativeProbe.available) return "unavailable-no-lib"
                return try {
                    NativeProbe.nativeOpenClStatus()
                } catch (_: Exception) {
                    "unavailable-error"
                }
            }
        }

        override fun timing(): TimingRunner = RuntimeTimingRunner.forInstalledSmol(appContext)
    }

    /**
     * Collect public device facts. Never null for driver absence — only
     * unreadable RAM (`ramMb <= 0`) yields null, matching the TS
     * `validateProbeRecord` rejection.
     */
    fun collectFacts(deps: Deps): DeviceFacts? {
        val ramMb = try {
            deps.ram().totalRamMb()
        } catch (_: Exception) {
            -1L
        }
        if (ramMb <= 0L) return null
        fun safe(block: () -> String, fallback: String): String {
            return try {
                block().takeIf { it.isNotBlank() } ?: fallback
            } catch (_: Exception) {
                fallback
            }
        }
        return DeviceFacts(
            socModel = safe({ deps.soc().socModel() }, "unknown"),
            gpuInfo = safe({ deps.gpu().rendererSummary() }, "unknown"),
            ramMb = ramMb,
            osVersion = safe({ deps.soc().osVersion() }, "unknown"),
            nnapiStatus = safe({ deps.nnapi().status() }, "unavailable-unknown"),
            vulkanStatus = safe({ deps.vulkan().status() }, "unavailable-unknown"),
            openClStatus = safe({ deps.openCl().status() }, "unavailable-unknown"),
        )
    }

    /**
     * Collect one measured sample. Null when arguments are blank, facts are
     * unreadable, no timing runner is wired, the runner cannot measure, or
     * the runner throws. A `correctnessPass = false` result still returns a
     * record — selection filters it, and a fast-but-wrong backend must
     * never win by hiding.
     */
    fun collect(
        backend: String,
        modelRev: String,
        corpusVersion: String,
        deps: Deps
    ): Record? {
        return when (val outcome = collectDetailed(backend, modelRev, corpusVersion, deps)) {
            is ProbeOutcome.Measured -> outcome.record
            is ProbeOutcome.Failed -> {
                logWarn(TAG, "probe not measured: ${outcome.reason}: ${outcome.detail}", null)
                null
            }
        }
    }

    /**
     * Phase A (Step 9): discriminated collection. Same rules as [collect],
     * but every failure carries its [BenchmarkFailure] instead of null.
     * A `correctnessPass = false` result is still Measured — selection
     * filters it, and a fast-but-wrong backend must never win by hiding.
     */
    fun collectDetailed(
        backend: String,
        modelRev: String,
        corpusVersion: String,
        deps: Deps
    ): ProbeOutcome {
        if (backend.isBlank() || modelRev.isBlank() || corpusVersion.isBlank()) {
            return ProbeOutcome.Failed(BenchmarkFailure.UNKNOWN_BACKEND, "blank probe identity")
        }
        val ramMb = try {
            deps.ram().totalRamMb()
        } catch (_: Exception) {
            -1L
        }
        if (ramMb <= 0L) {
            return ProbeOutcome.Failed(BenchmarkFailure.FACTS_UNREADABLE, "unreadable RAM")
        }
        val facts = collectFacts(deps)
            ?: return ProbeOutcome.Failed(BenchmarkFailure.FACTS_UNREADABLE, "device facts unreadable")
        val runner = deps.timing()
            ?: return ProbeOutcome.Failed(BenchmarkFailure.NO_TIMING_RUNNER, "no timing runner wired")
        val timing = try {
            runner.runDetailed(backend)
        } catch (e: Exception) {
            return ProbeOutcome.Failed(BenchmarkFailure.ENGINE_INIT_FAILED, "timing runner threw: ${e.message?.take(120)}")
        }
        return when (timing) {
            is BenchmarkOutcome.Success -> ProbeOutcome.Measured(
                Record(
                    socModel = facts.socModel,
                    gpuInfo = "${facts.gpuInfo} [nnapi=${facts.nnapiStatus} vulkan=${facts.vulkanStatus} opencl=${facts.openClStatus}]",
                    ramMb = facts.ramMb,
                    osVersion = facts.osVersion,
                    backend = backend,
                    ttftMs = timing.result.ttftMs,
                    tokensPerSec = timing.result.tokensPerSec,
                    corpusVersion = corpusVersion,
                    modelRev = modelRev,
                    correctnessPass = timing.result.correctnessPass,
                ),
            )
            is BenchmarkOutcome.Failure -> ProbeOutcome.Failed(timing.reason, timing.detail)
        }
    }

    /**
     * Headless EGL pbuffer + `GLES20.glGetString` renderer query. No
     * surface, no permission, no UI thread requirement (call off the UI
     * thread). Null when any EGL/GL step fails — the caller degrades to
     * `"unknown (egl)"`.
     */
    internal fun readGlRenderer(): String? {
        var display = EGL14.EGL_NO_DISPLAY
        var context = EGL14.EGL_NO_CONTEXT
        var surface = EGL14.EGL_NO_SURFACE
        try {
            display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
            if (display === EGL14.EGL_NO_DISPLAY) return null
            val version = IntArray(2)
            if (!EGL14.eglInitialize(display, version, 0, version, 1)) return null
            val configs = arrayOfNulls<android.opengl.EGLConfig>(1)
            val numConfigs = IntArray(1)
            val attribs = intArrayOf(
                EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
                EGL14.EGL_NONE,
            )
            if (!EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, numConfigs, 0) ||
                numConfigs[0] == 0
            ) return null
            val surfaceAttribs = intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE)
            surface = EGL14.eglCreatePbufferSurface(display, configs[0], surfaceAttribs, 0)
            if (surface == null || surface === EGL14.EGL_NO_SURFACE) return null
            context = EGL14.eglCreateContext(
                display, configs[0], EGL14.EGL_NO_CONTEXT,
                intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0,
            )
            if (context == null || context === EGL14.EGL_NO_CONTEXT) return null
            if (!EGL14.eglMakeCurrent(display, surface, surface, context)) return null
            val renderer = GLES20.glGetString(GLES20.GL_RENDERER) ?: return null
            val versionStr = GLES20.glGetString(GLES20.GL_VERSION)
            return if (versionStr.isNullOrBlank()) renderer else "$renderer ($versionStr)"
        } catch (_: Exception) {
            return null
        } finally {
            try {
                if (display !== EGL14.EGL_NO_DISPLAY) {
                    EGL14.eglMakeCurrent(
                        display,
                        EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT,
                    )
                    if (surface !== EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface)
                    if (context !== EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context)
                    EGL14.eglTerminate(display)
                }
            } catch (_: Exception) {
            }
        }
    }

    private const val TAG = "DeviceProbe"

    /**
     * Warning sink. Defaults to `android.util.Log` (unavailable on plain
     * JVM unit tests — the mockable android.jar throws); tests replace it
     * with a recorder/no-op and restore afterwards.
     */
    internal var logWarn: (tag: String, message: String, throwable: Throwable?) -> Unit =
        { tag, message, throwable -> Log.w(tag, message, throwable) }
}
