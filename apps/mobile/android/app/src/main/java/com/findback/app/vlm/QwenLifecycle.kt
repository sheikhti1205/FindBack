package com.findback.app.vlm

import java.io.File

/**
 * Transfer-state record for the qualified text entry. Entry-id keyed and
 * stored beside the authoritative `ModelStore` layout (see below) —
 * deliberately NOT under a `VlmModelId` wire dir, which stays exactly the
 * two image models. Writers: transfer completion, verified promotion,
 * and pause/resume/cancel/delete transitions only. Readers never infer
 * product state from file existence.
 */
data class QwenTextStateRecord(
    val entryId: String = QwenTextRuntime.ENTRY_ID,
    val revision: String = QwenTextRuntime.REVISION,
    val state: VlmState = VlmState.NOT_INSTALLED,
    val installedBytes: Long = 0L,
    val installTimestamp: Long = 0L,
    val installedSha256: String = "",
    val lastError: String? = null
)

/**
 * Frozen lifecycle status for the text entry: lifecycle-validated
 * `installed` vs diagnostic-only `modelFilePresent` vs observed
 * `textReady` vs `residentModelId`. A file merely existing never means
 * installed.
 */
data class QwenLifecycleStatus(
    val entryId: String,
    val modelId: String,
    val installed: Boolean,
    val modelFilePresent: Boolean,
    val textReady: Boolean,
    val residentModelId: String?
)

/**
 * Lifecycle SEMANTICS for the qualified on-device text entry (Y owner).
 * Pure over injected roots and records — no Android framework, no
 * scheduler, no second install root. Storage mechanics (promotion,
 * rollback, export source) are implemented against the mailbox store
 * interface by AA; residency exclusivity belongs to AB's arbiter, which
 * wraps the text controller this module never replaces.
 *
 * All paths resolve under the authoritative `ModelStore` root:
 * `root/<entryId>/<revision>/<file>` plus the transfer artifacts
 * (`<file>.part`, `<file>.journal.json`, `<file>.chunk.tmp`) and the
 * entry-id-keyed `text-state.json`.
 */
object QwenLifecycle {

    const val STATE_FILE_NAME = TextTransferStateStore.FILE_NAME

    /** Directory holding one entry's revisions, transfer artifacts, and state record. */
    fun entryDir(storeRoot: File, entryId: String = QwenTextRuntime.ENTRY_ID): File =
        File(storeRoot, entryId)

    /** Entry-id-keyed transfer-state record file (single persistence seam: [TextTransferStateStore]). */
    fun stateFile(storeRoot: File, entryId: String = QwenTextRuntime.ENTRY_ID): File =
        TextTransferStateStore.fileFor(storeRoot, entryId)

    /**
     * Loads the persisted text transfer state, or null when absent/unreadable.
     * Delegates to the single persistence seam; validation stays here.
     */
    fun loadState(storeRoot: File, entryId: String = QwenTextRuntime.ENTRY_ID): QwenTextStateRecord? {
        val file = stateFile(storeRoot, entryId)
        return TextTransferStateStore.load(file)?.toRecord()
    }

    /**
     * Persists the text transfer state via the single persistence seam
     * (atomic temp + rename). Validation stays here.
     */
    fun saveState(storeRoot: File, record: QwenTextStateRecord) {
        TextTransferStateStore.saveAtomic(
            stateFile(storeRoot, record.entryId),
            record.toTransferState()
        )
    }

    /** In-memory record ↔ persistence-seam conversions (field-identical schemas). */
    private fun TextTransferState.toRecord(): QwenTextStateRecord =
        QwenTextStateRecord(
            entryId = entryId,
            revision = revision,
            state = state,
            installedBytes = installedBytes,
            installTimestamp = installTimestamp,
            installedSha256 = installedSha256,
            lastError = lastError
        )

    private fun QwenTextStateRecord.toTransferState(): TextTransferState =
        TextTransferState(
            entryId = entryId,
            revision = revision,
            state = state,
            installedBytes = installedBytes,
            installedSha256 = installedSha256,
            installTimestamp = installTimestamp,
            lastError = lastError
        )

    /** Diagnostic file-presence probe only — never lifecycle state. */
    fun isFilePresent(storeRoot: File, manifest: ModelManifest = QwenTextRuntime.manifest()): Boolean {
        val spec = manifest.files.firstOrNull() ?: return false
        return try {
            File(File(storeRoot, "${manifest.id}/${manifest.revision}"), spec.path).exists()
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Lifecycle-validated install: the record must carry a verified
     * promotion (state + revision + installed-weights hash) AND the final
     * file must exist at the pinned size. No re-hash on the read path —
     * the hash is asserted once at promotion and carried in the record.
     */
    fun isInstalledValid(
        storeRoot: File,
        record: QwenTextStateRecord?,
        manifest: ModelManifest = QwenTextRuntime.manifest()
    ): Boolean {
        if (record == null) return false
        if (record.state != VlmState.INSTALLED_UNVERIFIED) return false
        if (record.entryId != manifest.id || record.revision != manifest.revision) return false
        val spec = manifest.files.firstOrNull() ?: return false
        if (record.installedSha256 != spec.sha256) return false
        if (record.installedBytes != spec.expectedBytes) return false
        return try {
            val final = File(File(storeRoot, "${manifest.id}/${manifest.revision}"), spec.path)
            final.exists() && final.length() == spec.expectedBytes
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Boot reconciliation for transient transfer states with no live job
     * (the text path has no platform scheduler to reconcile against):
     * verified chunks staged → PAUSED for resume, otherwise NOT_INSTALLED.
     */
    fun reconcileAtBoot(record: QwenTextStateRecord?, partExists: Boolean): VlmState {
        val state = record?.state ?: return VlmState.NOT_INSTALLED
        return when (state) {
            VlmState.QUEUED, VlmState.DOWNLOADING, VlmState.PAUSING,
            VlmState.VERIFYING_CHUNK, VlmState.VERIFYING_HASH, VlmState.VERIFYING_FILE,
            VlmState.REPAIRING -> if (partExists) VlmState.PAUSED else VlmState.NOT_INSTALLED
            else -> state
        }
    }

    /** TEXT_READY verification: success proof plus the canonical ready state. */
    fun isTextReady(ready: Boolean, state: String): Boolean =
        ready && state == TextRuntimeController.STATE_READY

    /** Composes the frozen status from its four independent signals. */
    fun composeStatus(
        installed: Boolean,
        modelFilePresent: Boolean,
        textReady: Boolean,
        residentModelId: String?
    ): QwenLifecycleStatus = QwenLifecycleStatus(
        entryId = QwenTextRuntime.ENTRY_ID,
        modelId = QwenTextRuntime.BRIDGE_MODEL_ID,
        installed = installed,
        modelFilePresent = modelFilePresent,
        textReady = textReady,
        residentModelId = residentModelId
    )

    /**
     * Deletes exactly one entry's directory (all revisions, transfer
     * artifacts, state record) and nothing outside that prefix. Returns
     * the deleted relative paths, sorted. A missing directory deletes
     * nothing and returns empty.
     */
    fun deleteExactly(storeRoot: File, entryId: String = QwenTextRuntime.ENTRY_ID): List<String> {
        if (TextTransferStateStore.isUnsafeEntryId(entryId)) {
            throw IllegalArgumentException("Unsafe entry id: $entryId")
        }
        val dir = entryDir(storeRoot, entryId)
        if (!dir.exists()) return emptyList()
        val deleted = mutableListOf<String>()
        collectRelative(dir, dir, deleted)
        deleteRecursively(dir)
        return deleted.sorted()
    }

    private fun collectRelative(root: File, current: File, out: MutableList<String>) {
        current.listFiles()?.forEach { child ->
            if (child.isDirectory) {
                collectRelative(root, child, out)
            } else {
                out.add(child.relativeTo(root).path.replace(File.separatorChar, '/'))
            }
        }
    }

    private fun deleteRecursively(file: File) {
        if (file.isDirectory) {
            file.listFiles()?.forEach { deleteRecursively(it) }
        }
        file.delete()
    }
}
