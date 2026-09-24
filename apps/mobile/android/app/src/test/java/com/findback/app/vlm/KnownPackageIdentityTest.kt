package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class KnownPackageIdentityTest {
    @Test
    fun knownCatalogueIdsResolveOnlyTheirOwnTrustedPackagePins() {
        val smol = KnownPackageIdentity.forCatalogueId("smolvlm2-500m-litert-int4")!!
        assertEquals("smolvlm2-500m", smol.manifest.id)
        assertEquals("6504b9e8972b40bd16f87b8e3bf680b2091b2f135cc23189cc0f8c86a3f1b137", smol.packageSha256)
        assertEquals("b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0", smol.manifest.files.single().sha256)
        val qwen = KnownPackageIdentity.forCatalogueId("qwen3-0.6b-litert-dynamic-int4")!!
        assertEquals(QwenTextRuntime.ENTRY_ID, qwen.manifest.id)
        assertEquals("83109b67d59e349e7fdbd178a4742030656813edd9442c8713ca71b38e4a1efb", qwen.packageSha256)
        // The LFM VL fixB entry has a pinned raw candidate record in
        // PinnedModelSources (installed-weights identity, downloadable via the
        // raw path) but no prepared `.fbmodel` whole-package pin — so the
        // whole-package identity stays null here by design. Historical caveat
        // preserved: raw fixB was never a release package.
        assertNull(KnownPackageIdentity.forCatalogueId("lfm2.5-vl-450m"), "Raw fixB has no prepared whole-package hash (raw weights pinned separately)")
        assertNull(KnownPackageIdentity.forCatalogueId("smolvlm2-500m"), "Image runtime id cannot masquerade as catalogue package id")
        assertNull(KnownPackageIdentity.forCatalogueId("unknown"))
    }
}
