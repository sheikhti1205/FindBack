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
        handle.initialize()
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
        handle.initialize()
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
        val handle = synchronized(lock) {
            if (ready && role == Role.IMAGE) vision else null
        } ?: throw IllegalStateException("No resident image candidate to run.")
        return handle.run(prepared, instruction, maxOutputTokens, temperature, traceId)
    }

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
        val handle = synchronized(lock) {
            if (ready && role == Role.TEXT && entryId == requestedEntryId) text else null
        } ?: throw IllegalStateException(
            "No resident text candidate for \"$requestedEntryId\"."
        )
        return handle.run(prompt, maxOutputTokens, temperature)
    }

    /** Best-effort cancel of an in-flight candidate text generation. */
    fun cancel() {
        synchronized(lock) { text }?.cancel()
    }

    /** Releases the resident candidate engine, if any. */
    fun release() {
        val (staleVision, staleText) = synchronized(lock) {
            val v = vision
            val t = text
            vision = null
            text = null
            entryId = null
            role = null
            ready = false
            v to t
        }
        try {
            staleVision?.release()
        } catch (_: Exception) {
        }
        try {
            staleText?.release()
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
