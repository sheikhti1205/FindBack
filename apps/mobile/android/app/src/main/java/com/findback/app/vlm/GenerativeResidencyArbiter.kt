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

    /**
     * Single-transaction eviction of every resident, AI-02 fix.
     *
     * Unlike [releaseAll] (record clear only), this also evicts the
     * experimental candidate — which lives outside the dedicated role
     * record — plus the recorded dedicated resident. Verify/use probes call
     * this before initializing a fresh engine so two generative engines can
     * never overlap. Eviction delegates to the existing lifecycle release
     * paths (which defer the close while native code runs); the arbiter
     * itself never closes an engine. Residency is runtime state only: the
     * caller's persisted selection pointer is untouched, so after a probe
     * the selection still reads "selected" while residency reads empty
     * until the next lazy activation.
     */
    @Synchronized
    fun evictAllResidents(): ResidencySnapshot {
        evictCandidate()
        when (residentRole) {
            ResidencyRole.IMAGE -> evictImage()
            ResidencyRole.TEXT -> evictText()
            null -> Unit
        }
        residentRole = null
        residentEntryId = null
        return snapshot()
    }

    @Synchronized
    fun snapshot(): ResidencySnapshot = ResidencySnapshot(residentEntryId, residentRole)
}
