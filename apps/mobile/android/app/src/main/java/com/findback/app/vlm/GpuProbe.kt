package com.findback.app.vlm

import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.GLES20
import android.util.Log

/**
 * GPU facts for the capabilities payload.
 *
 * The LiteRT GPU accelerator (`com.google.ai.edge.litert:litert-gpu`) ships
 * `org.tensorflow.lite.gpu.GpuDelegate`. There is no
 * `com.google.ai.edge.litert.gpu.GpuDelegate` class, so probing for that name always threw
 * `ClassNotFoundException` and the app reported "no GPU runtime" on every device — including
 * phones with a working GPU, which made the GPU self-test look like a hardware limitation.
 */
object GpuProbe {
    private const val TAG = "GpuProbe"

    /** Class provided by `com.google.ai.edge.litert:litert-gpu` (verified in the AAR). */
    const val GPU_DELEGATE_CLASS = "org.tensorflow.lite.gpu.GpuDelegate"

    fun runtimePresent(): Boolean = try {
        Class.forName(GPU_DELEGATE_CLASS)
        true
    } catch (e: ClassNotFoundException) {
        false
    }

    /**
     * `(vendor, renderer)` read from a throwaway 1x1 EGL pbuffer, or `(null, null)` when EGL is
     * unavailable. Defensive by design: a failure here degrades to "unknown", never a crash.
     */
    fun info(): Pair<String?, String?> {
        var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
        var context: EGLContext = EGL14.EGL_NO_CONTEXT
        var surface: EGLSurface = EGL14.EGL_NO_SURFACE
        return try {
            display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
            val version = IntArray(2)
            if (display == EGL14.EGL_NO_DISPLAY || !EGL14.eglInitialize(display, version, 0, version, 1)) {
                Pair(null, null)
            } else {
                val configs = arrayOfNulls<EGLConfig>(1)
                val numConfigs = IntArray(1)
                val configAttribs = intArrayOf(
                    EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                    EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT,
                    EGL14.EGL_NONE,
                )
                if (!EGL14.eglChooseConfig(display, configAttribs, 0, configs, 0, 1, numConfigs, 0) ||
                    numConfigs[0] == 0
                ) {
                    Pair(null, null)
                } else {
                    val contextAttribs = intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE)
                    context = EGL14.eglCreateContext(display, configs[0], EGL14.EGL_NO_CONTEXT, contextAttribs, 0)
                    val surfaceAttribs = intArrayOf(
                        EGL14.EGL_WIDTH, 1,
                        EGL14.EGL_HEIGHT, 1,
                        EGL14.EGL_NONE,
                    )
                    surface = EGL14.eglCreatePbufferSurface(display, configs[0], surfaceAttribs, 0)
                    if (context == EGL14.EGL_NO_CONTEXT ||
                        surface == EGL14.EGL_NO_SURFACE ||
                        !EGL14.eglMakeCurrent(display, surface, surface, context)
                    ) {
                        Pair(null, null)
                    } else {
                        Pair(GLES20.glGetString(GLES20.GL_VENDOR), GLES20.glGetString(GLES20.GL_RENDERER))
                    }
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "GPU info query failed: ${e.message}")
            Pair(null, null)
        } finally {
            try {
                if (display != EGL14.EGL_NO_DISPLAY) {
                    EGL14.eglMakeCurrent(
                        display,
                        EGL14.EGL_NO_SURFACE,
                        EGL14.EGL_NO_SURFACE,
                        EGL14.EGL_NO_CONTEXT,
                    )
                    if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface)
                    if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context)
                    EGL14.eglTerminate(display)
                }
            } catch (_: Throwable) {
            }
        }
    }
}
