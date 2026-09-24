package com.findback.app.vlm

/**
 * Resident, single-slot runtime for a verified experimental candidate entry.
 *
 * The two recommended entries keep their dedicated production paths
 * ([VlmEngine500] behind the warm lease and [TextRuntimeController] behind the
 * qualified Qwen bridge id). This controller gives the four experimental
 * raw-weight candidates the same *runnable* capability without weakening
 * either dedicated path:
 *
 * - At most ONE candidate engine is resident at a time, matching the
 *   single-resident generative-model invariant (guard G7).
 * - A candidate becomes resident only after its installed weights verified
 *   (`CandidateModelStatus.hasVerifiedWeights`), enforced by the plugin
 *   before [activateImage] / [activateText] is ever called.
 * - The engine is the exact same generic LiteRT-LM host the candidate verify
 *   probe used ([VlmEngine500] / [LiteRtQwenTextHost]); nothing here is
 *   model-family specific beyond role dispatch. Handles keep this class free
 *   of Android framework types so it is JVM-testable with fakes.
 *
 * Role is decided by the caller from the catalogue id: the LFM2.5 VL 450M
 * fixB entry is a vision candidate, the three text candidates share the text
 * host.
 */
class CandidateRuntimeController {

    enum class Role(val wire: String) {
        IMAGE("IMAGE"),
        TEXT("TEXT")
    }

    /** Minimal initialized vision surface the runtime drives. */
    class VisionHandle(
        val initialize: () -> Unit,
        val run: (ImagePreparer.PreparedImage, String, Int, Float, String?) -> String,
        val release: () -> Unit
    )

    /** Minimal text surface the runtime drives. */
    class TextHandle(
        val initialize: () -> Unit,
        val run: (String, Int, Float) -> String,
        val cancel: () -> Unit,
        val release: () -> Unit
    )

    private val lock = Any()
    private var entryId: String? = null
    private var role: Role? = null
    private var vision: VisionHandle? = null
    private var text: TextHandle? = null
    // In-flight generation lease (AI-01): analyzeImage/generateText capture
    // their handle under [lock], bump [inFlight], then run outside the lock.
    // release() always clears residency synchronously so status reads are
    // honest, but when generations are in flight the handle close is queued
    // in [deferredCloses] and drained by the last finishing run in its
    // finally block — never closing underneath native work, never
    // double-closing. Closes always run outside [lock]: no deadlock.
    private var inFlight = 0
    private val deferredCloses = ArrayDeque<() -> Unit>()

    @Volatile
    private var ready = false

    /** Catalogue id of the resident candidate, or null when none is resident. */
    fun residentEntryId(): String? = synchronized(lock) { entryId }

    /** Role of the resident candidate, or null when none is resident. */
    fun residentRole(): Role? = synchronized(lock) { role }

    /** True only for the entry that is resident AND genuinely initialized. */
    fun isActive(entryId: String): Boolean =
        synchronized(lock) { ready && this.entryId == entryId }

    /** Resident image entry id, or null when no image candidate is resident. */
    fun residentImageEntryId(): String? =
        synchronized(lock) { entryId.takeIf { ready && role == Role.IMAGE } }

    /** Resident text entry id, or null when no text candidate is resident. */
    fun residentTextEntryId(): String? =
        synchronized(lock) { entryId.takeIf { ready && role == Role.TEXT } }

    /**
     * Evicts any resident candidate, initializes `handle`, then marks
     * `entryId` resident. A failed initialization leaves no candidate
     * resident and propagates so the caller reports an honest failure
     * instead of a false "ready".
     */
    fun activateImage(entryId: String, handle: VisionHandle) {
        release()
        // AI-05: a throwing initialize() leaves the handle untracked, so the
        // plugin catch cannot reach it. Close it here and rethrow the
        // original failure instead of leaking a partial engine.
        try {
            handle.initialize()
        } catch (t: Throwable) {
            safeClose { handle.release() }
            throw t
        }
        synchronized(lock) {
            this.entryId = entryId
            this.role = Role.IMAGE
            this.vision = handle
            this.text = null
            ready = true
        }
    }

    /** Text counterpart of [activateImage]. */
    fun activateText(entryId: String, handle: TextHandle) {
        release()
        try {
            handle.initialize()
        } catch (t: Throwable) {
            safeClose { handle.release() }
            throw t
        }
        synchronized(lock) {
            this.entryId = entryId
            this.role = Role.TEXT
            this.text = handle
            this.vision = null
            ready = true
        }
    }

    /**
     * Runs one image generation on the resident image candidate. Throws when
     * no image candidate is resident — never falls back to another model.
     */
    fun analyzeImage(
        prepared: ImagePreparer.PreparedImage,
        instruction: String,
        maxOutputTokens: Int,
        temperature: Float,
        traceId: String?
    ): String {
        val handle = acquireVision()
        try {
            return handle.run(prepared, instruction, maxOutputTokens, temperature, traceId)
        } finally {
            endRun()
        }
    }

    /**
     * P1: atomic handle+lease acquisition in ONE lock section. Selecting the
     * handle and taking the lease in two steps let release() close the
     * captured handle in between (inFlight still 0) before the run started.
     * Either the caller holds a live handle with the close deferred, or it
     * throws before touching anything — never a run on a closed handle.
     */
    internal fun acquireVision(): VisionHandle =
        synchronized(lock) {
            val handle = if (ready && role == Role.IMAGE) vision else null
            if (handle != null) inFlight++
            handle
        } ?: throw IllegalStateException("No resident image candidate to run.")

    /**
     * Runs one text generation on the resident text candidate. Throws when
     * the requested entry is not the resident text candidate.
     */
    fun generateText(
        requestedEntryId: String,
        prompt: String,
        maxOutputTokens: Int,
        temperature: Float
    ): String {
        val handle = acquireText(requestedEntryId)
        try {
            return handle.run(prompt, maxOutputTokens, temperature)
        } finally {
            endRun()
        }
    }

    /** Text counterpart of [acquireVision]: atomic select+lease or throw. */
    internal fun acquireText(requestedEntryId: String): TextHandle =
        synchronized(lock) {
            val handle =
                if (ready && role == Role.TEXT && entryId == requestedEntryId) text else null
            if (handle != null) inFlight++
            handle
        } ?: throw IllegalStateException(
            "No resident text candidate for \"$requestedEntryId\"."
        )

    /** Best-effort cancel of an in-flight candidate text generation. */
    fun cancel() {
        synchronized(lock) { text }?.cancel()
    }

    /** Releases the resident candidate engine, if any. */
    fun release() {
        val staleVision: VisionHandle?
        val staleText: TextHandle?
        synchronized(lock) {
            staleVision = vision
            staleText = text
            vision = null
            text = null
            entryId = null
            role = null
            ready = false
        }
        val closes = mutableListOf<() -> Unit>()
        if (staleVision != null) closes.add { staleVision.release() }
        if (staleText != null) closes.add { staleText.release() }
        if (closes.isEmpty()) return
        // Residency is already cleared above; only the close defers while a
        // generation holds the lease. A second release() sees null handles,
        // so each handle closes at most once.
        val immediate: List<() -> Unit> = synchronized(lock) {
            if (inFlight > 0) {
                deferredCloses.addAll(closes)
                emptyList()
            } else {
                closes
            }
        }
        immediate.forEach { safeClose(it) }
    }

    /**
     * Finishes one acquired lease, draining a deferred close outside [lock]
     * when the last in-flight generation completes. Safe to call without a
     * lease only in tests; production pairs every acquire with exactly one
     * endRun in `finally`.
     */
    internal fun endRun() {
        val pending: List<() -> Unit> = synchronized(lock) {
            if (inFlight > 0) inFlight--
            if (inFlight == 0 && deferredCloses.isNotEmpty()) {
                val drained = deferredCloses.toList()
                deferredCloses.clear()
                drained
            } else {
                emptyList()
            }
        }
        pending.forEach { safeClose(it) }
    }

    private fun safeClose(close: () -> Unit) {
        try {
            close()
        } catch (_: Exception) {
        }
    }

    companion object {
        /** Catalogue id of the single vision candidate (LFM2.5 VL 450M fixB). */
        const val VISION_ENTRY = "lfm2.5-vl-450m"

        /** Candidate role for a catalogue entry id, or null when not a candidate. */
        fun roleFor(entryId: String): Role? =
            if (PinnedModelSources.manifests.any { it.id == entryId }) {
                if (entryId == VISION_ENTRY) Role.IMAGE else Role.TEXT
            } else {
                null
            }
    }
}
