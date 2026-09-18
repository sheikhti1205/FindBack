package com.findback.app.vlm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GpuProbe is the capabilities source for `gpuDelegateClassPresent`,
 * `gpuVendor` and `gpuRenderer`. The class-presence probe proves only that
 * the litert-gpu delegate ships in the APK — never that the LiteRT-LM 500M
 * GPU runtime works. Only the image-bearing 500M self-test establishes
 * READY_GPU (audit #26).
 */
class GpuProbeTest {

    @Test
    fun `delegate class is the one litert-gpu ships, not the old guess`() {
        assertEquals("org.tensorflow.lite.gpu.GpuDelegate", GpuProbe.GPU_DELEGATE_CLASS)
        // The old probe target never existed; it kept the capability false
        // on every device.
        var oldClassPresent = true
        try {
            Class.forName("com.google.ai.edge.litert.gpu.GpuDelegate")
        } catch (_: ClassNotFoundException) {
            oldClassPresent = false
        }
        assertFalse(oldClassPresent)
    }

    @Test
    fun `delegate class presence is reported, not runtime availability`() {
        // The delegate AAR is a real dependency, so the class resolves even
        // in plain JVM unit tests — exactly what the old name never did.
        assertTrue(GpuProbe.gpuDelegateClassPresent())
    }

    @Test
    fun `info never throws and degrades to unknown without EGL`() {
        val (vendor, renderer) = GpuProbe.info()
        assertNull(vendor)
        assertNull(renderer)
    }
}
