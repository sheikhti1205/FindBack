package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PluginInitStructureTest {

    @Test fun noLazyContextDelegatesForStoreDownloaderPrefs() {
        val fields = LocalVlmPlugin::class.java.declaredFields.map { it.name }
        assertNull(
            fields.singleOrNull { it.contains("store") && it.contains("delegate") },
            "store must not be a lazy delegate; init in load()"
        )
        assertNull(
            fields.singleOrNull { it.contains("downloader") && it.contains("delegate") },
            "downloader must not be a lazy delegate; init in load()"
        )
        assertNull(
            fields.singleOrNull { it.contains("prefs") && it.contains("delegate") },
            "prefs must not be a lazy delegate; init in load()"
        )
    }

    @Test fun initGuardAndInferenceTokenPresent() {
        val methods = LocalVlmPlugin::class.java.declaredMethods.map { it.name }
        assertTrue(methods.contains("ensureInitialized"))
        assertTrue(methods.contains("scheduleLeaseExpiry") || methods.contains("reclaimExpiredLease"))
        val fields = LocalVlmPlugin::class.java.declaredFields.map { it.name }
        assertTrue(fields.contains("activeInference"))
        assertTrue(fields.contains("initialized"))
    }

    @Test fun cancelAndDeletePathsExist() {
        val methods = LocalVlmPlugin::class.java.declaredMethods.map { it.name }
        assertNotNull(methods.singleOrNull { it == "cancelInference" })
        assertNotNull(methods.singleOrNull { it == "deleteModel" })
        assertNotNull(methods.singleOrNull { it == "releaseWarmLease" })
    }
}
