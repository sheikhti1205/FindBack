package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * RED: export selection ceiling — installed imported models are selectable.
 * Bound is documented as 6 catalogue slots + up to 8 imported slots.
 */
class ExportSelectionPolicyTest {

    private fun catalogueIds(): List<String> = SixModelCatalogue.ALL_SIX

    @Test
    fun boundIsDocumentedSixPlusEight() {
        assertEquals(6, ExportSelectionPolicy.CATALOGUE_SLOTS)
        assertEquals(8, ExportSelectionPolicy.IMPORTED_SLOTS)
        assertEquals(14, ExportSelectionPolicy.MAX_EXPORT_SELECTION)
    }

    @Test
    fun sevenPlusEntriesIncludingImportedSucceed() {
        // 8 valid namespaced imported ids (64 lowercase hex).
        val importedIds = List(8) { i -> PackageHost.sha256Hex("imported-$i".toByteArray()) }
        val selection = catalogueIds().take(6) + importedIds.take(2)
        assertEquals(8, selection.size)
        val ok = ExportSelectionPolicy.validate(selection) { true }
        assertTrue(ok, "7+ entry selection including imported IDs must succeed")
        val full = catalogueIds().take(6) + importedIds
        assertEquals(14, full.size)
        assertTrue(ExportSelectionPolicy.validate(full) { true })
    }

    @Test
    fun overBoundDuplicatesAndUnknownAreRejected() {
        val importedIds = List(8) { i -> PackageHost.sha256Hex("imported-$i".toByteArray()) }
        val over = catalogueIds().take(6) + importedIds + listOf(PackageHost.sha256Hex("extra".toByteArray()))
        assertEquals(15, over.size)
        assertFalse(ExportSelectionPolicy.validate(over) { true })
        val dup = listOf(catalogueIds().first(), catalogueIds().first())
        assertFalse(ExportSelectionPolicy.validate(dup) { true })
        assertFalse(ExportSelectionPolicy.validate(emptyList()) { true })
        assertFalse(ExportSelectionPolicy.validate(listOf(catalogueIds().first())) { false })
    }
}
