package com.findback.app.vlm

/**
 * Single-residency arbiter over the image engine and the text controller.
 *
 * At most one generative engine is resident: acquiring one role evicts the
 * other role first, then records the new resident, all under one lock, so
 * the record can never show both roles resident. Eviction delegates to the
 * existing lifecycle release paths, which defer the close while native code
 * runs instead of closing underneath it; the arbiter itself never closes an
 * engine and owns no lifecycle state. Residency is runtime state only.
 */
class GenerativeResidencyArbiter(
    private val evictImage: () -> Unit = {},
    private val evictText: () -> Unit = {},
    private val evictCandidate: () -> Unit = {}
) {
    enum class ResidencyRole { IMAGE, TEXT }

    data class ResidencySnapshot(
        val residentEntryId: String?,
        val residentRole: ResidencyRole?
    )

    private var residentEntryId: String? = null
    private var residentRole: ResidencyRole? = null

    @Synchronized
    fun acquireImage(entryId: String): ResidencySnapshot {
        // A dedicated resident always evicts any experimental candidate
        // first: the candidate sits outside this arbiter's role record but
        // obeys the same single-resident invariant.
        evictCandidate()
        if (residentRole == ResidencyRole.TEXT) evictText()
        residentRole = ResidencyRole.IMAGE
        residentEntryId = entryId
        return snapshot()
    }

    @Synchronized
    fun acquireText(entryId: String): ResidencySnapshot {
        evictCandidate()
        if (residentRole == ResidencyRole.IMAGE) evictImage()
        residentRole = ResidencyRole.TEXT
        residentEntryId = entryId
        return snapshot()
    }

    @Synchronized
    fun release(role: ResidencyRole, entryId: String? = null): ResidencySnapshot {
        if (residentRole == role && (entryId == null || entryId == residentEntryId)) {
            residentRole = null
            residentEntryId = null
        }
        return snapshot()
    }

    @Synchronized
    fun releaseAll(): ResidencySnapshot {
        residentRole = null
        residentEntryId = null
        return snapshot()
    }

    @Synchronized
    fun snapshot(): ResidencySnapshot = ResidencySnapshot(residentEntryId, residentRole)
}
