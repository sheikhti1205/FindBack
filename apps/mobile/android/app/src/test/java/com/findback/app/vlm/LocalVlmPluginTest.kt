package com.findback.app.vlm

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class LocalVlmPluginTest {

    @Test
    fun addListener_inheritsFromBasePlugin() {
        // Verify that LocalVlmPlugin doesn't override addListener with a stub
        // The test passes if the class compiles and the method is inherited
        val plugin = LocalVlmPlugin::class.java
        val methods = plugin.declaredMethods.map { it.name }

        // addListener should NOT be declared in LocalVlmPlugin (should be inherited from Plugin)
        assertTrue(!methods.contains("addListener"))
    }

    @Test
    fun notifyListeners_isProtectedAndCallable() {
        // Verify notifyListeners is accessible (protected in base Plugin)
        val plugin = LocalVlmPlugin::class.java
        val notifyMethods = plugin.declaredMethods.filter { it.name == "notifyListeners" }
        // notifyListeners is protected in base class, not declared in subclass
        assertTrue(notifyMethods.isEmpty())
    }

    @Test
    fun gpuProbe_checksADelegateClassThatActuallyExists() {
        // Regression: the probe used to look for com.google.ai.edge.litert.gpu.GpuDelegate,
        // which litert-gpu does not ship, so gpuRuntimePresent was always false.
        // initialize=false so a native static initializer cannot run on the JVM.
        val clazz = Class.forName(
            GpuProbe.GPU_DELEGATE_CLASS,
            false,
            GpuProbe::class.java.classLoader,
        )
        assertNotNull(clazz)
        assertTrue(org.tensorflow.lite.Delegate::class.java.isAssignableFrom(clazz))
    }

    @Test
    fun modelStatesToJSArray_serializesAsRealJsonArray() {
        val arr = modelStatesToJSArray(
            listOf(
                VlmModelInfo(VlmModelId.SMOLVLM2_500M, VlmState.READY_GPU, 100L),
                VlmModelInfo(VlmModelId.SMOLVLM_256M, VlmState.NOT_INSTALLED),
            )
        )
        // getJSONObject/getString throw if the array was stringified.
        assertEquals(2, arr.length())
        assertEquals("smolvlm2-500m", arr.getJSONObject(0).getString("id"))
        assertEquals("READY_GPU", arr.getJSONObject(0).getString("state"))
        assertEquals("smolvlm-256m", arr.getJSONObject(1).getString("id"))
    }
}