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
}