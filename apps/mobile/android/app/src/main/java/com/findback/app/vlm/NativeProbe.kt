package com.findback.app.vlm

/**
 * JNI entry to the `findback_probe` native library (dlopen-only NNAPI /
 * Vulkan / OpenCL capability probes). The library is optional: when it is
 * absent (or a call throws) every probe reports an `unavailable-*` status
 * string instead of crashing. Absence is data, never an error.
 */
internal object NativeProbe {
    val available: Boolean = try {
        System.loadLibrary("findback_probe")
        true
    } catch (_: UnsatisfiedLinkError) {
        false
    } catch (_: SecurityException) {
        false
    }

    external fun nativeNnapiStatus(): String
    external fun nativeVulkanStatus(): String
    external fun nativeOpenClStatus(): String
}
