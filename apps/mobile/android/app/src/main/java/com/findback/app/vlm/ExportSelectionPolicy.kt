package com.findback.app.vlm

/**
 * Bounded export-selection policy for the share sheet.
 *
 * Bound: 6 catalogue slots (the [SixModelCatalogue.ALL_SIX] entries) + up to
 * 8 imported slots ([ImportedModelRegistry] entries), for a maximum of 14
 * separately packaged `.fbmodel` files from one directory choice (never a
 * combined archive). The bound keeps the SAF export loop bounded while
 * letting every installed imported model stay selectable.
 */
object ExportSelectionPolicy {
    /** Catalogue slots: exactly the six Phase A catalogue entries. */
    const val CATALOGUE_SLOTS = 6

    /** Imported slots: up to eight user-imported models per export batch. */
    const val IMPORTED_SLOTS = 8

    /** Maximum entries per export batch: 6 catalogue + up to 8 imported. */
    const val MAX_EXPORT_SELECTION = CATALOGUE_SLOTS + IMPORTED_SLOTS

    /**
     * True when [entryIds] is a non-empty, duplicate-free batch within the
     * bound and every id is exportable per [isExportable].
     */
    fun validate(entryIds: List<String>, isExportable: (String) -> Boolean): Boolean {
        if (entryIds.isEmpty() || entryIds.size > MAX_EXPORT_SELECTION) return false
        if (entryIds.toSet().size != entryIds.size) return false
        return entryIds.all { isExportable(it) }
    }
}
