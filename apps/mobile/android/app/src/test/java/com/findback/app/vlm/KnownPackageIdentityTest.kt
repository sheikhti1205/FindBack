package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class KnownPackageIdentityTest {
    @Test
    fun knownCatalogueIdsResolveOnlyTheirOwnTrustedPackagePins() {
        val smol = KnownPackageIdentity.forCatalogueId("smolvlm2-500m-litert-int4")!!
        assertEquals("smolvlm2-500m", smol.manifest.id)
        assertEquals("41e11106a57ae750f61d992ab195f90b9f7bc58c39009b5dac0ce9d1c60a366e", smol.packageSha256)
        assertEquals("b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0", smol.manifest.files.single().sha256)
        val qwen = KnownPackageIdentity.forCatalogueId("qwen3-0.6b-litert-dynamic-int4")!!
        assertEquals(QwenTextRuntime.ENTRY_ID, qwen.manifest.id)
        assertEquals("8a8a2d5747aa804c8f39e79658d2b3e5962f0451e0e16571b6bdb9dcd8205821", qwen.packageSha256)
        assertNull(KnownPackageIdentity.forCatalogueId("lfm2.5-vl-450m"), "Raw fixB has no prepared package hash")
        assertNull(KnownPackageIdentity.forCatalogueId("smolvlm2-500m"), "Image runtime id cannot masquerade as catalogue package id")
        assertNull(KnownPackageIdentity.forCatalogueId("unknown"))
    }
}
