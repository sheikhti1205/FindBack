package com.findback.app.vlm

/**
 * Pure commit gating for the unknown-import flow.
 *
 * Unknown commit requires an explicit user-confirmed bounded name+role
 * and a recorded probe: either a successful bounded generation, or a
 * typed memory failure plus explicit `keepUnverified`. An incompatible
 * probe (or no probe at all) can never be kept. Known catalogue entries
 * never pass through here.
 */
object ImportCommitPolicy {
    const val MAX_NAME_CHARS = 80
    const val MAX_DESCRIPTION_CHARS = 500

    data class CommitDecision(val ok: Boolean, val code: String? = null, val reason: String? = null)

    fun validateUnknown(
        name: String?,
        role: String?,
        description: String?,
        keepUnverified: Boolean,
        probe: ProbeResult?,
        probedRole: String?
    ): CommitDecision {
        val label = name?.trim() ?: ""
        if (label.isEmpty() || label.length > MAX_NAME_CHARS) {
            return CommitDecision(false, PackageHost.Code.ENTRY_MISMATCH, "Confirm a model name (1–80 characters).")
        }
        if (label.contains('\n') || label.contains('\r') || label.contains('\u0000')) {
            return CommitDecision(false, PackageHost.Code.ENTRY_MISMATCH, "Confirm a model name (1–80 characters).")
        }
        if (role != "Text" && role != "Vision") {
            return CommitDecision(false, PackageHost.Code.ENTRY_MISMATCH, "Confirm whether the model is for Text or Images.")
        }
        if (description != null && description.length > MAX_DESCRIPTION_CHARS) {
            return CommitDecision(false, PackageHost.Code.ENTRY_MISMATCH, "Description must be 500 characters or fewer.")
        }
        if (probe == null) {
            return CommitDecision(false, PackageHost.Code.CORRUPT_ARCHIVE, "Test compatibility before adding this model.")
        }
        if (probedRole != role) {
            return CommitDecision(false, PackageHost.Code.ENTRY_MISMATCH, "Test compatibility for the confirmed role before adding this model.")
        }
        if (probe.ready) return CommitDecision(true)
        if (probe.lowMemory && keepUnverified) return CommitDecision(true)
        if (probe.lowMemory) {
            return CommitDecision(
                false, "KEEP_UNVERIFIED_REQUIRED",
                "Memory was too low to finish the test. Keep anyway, try again, or remove."
            )
        }
        return CommitDecision(
            false, PackageHost.Code.ENTRY_MISMATCH,
            "This model cannot run with this FindBack build and cannot be kept."
        )
    }

    fun namespacedEntryId(packageSha256: String): String? {
        val normalized = packageSha256.lowercase()
        if (!Regex("[0-9a-f]{64}").matches(normalized)) return null
        return normalized
    }

    fun isNamespacedEntryId(entryId: String): Boolean = namespacedEntryId(entryId) != null

    fun sanitizeFileStem(label: String, fallbackSha: String): String {
        val cleaned = label.trim().lowercase()
            .map { if (it.isLetterOrDigit() || it == '-' || it == '_') it else '-' }
            .joinToString("").replace(Regex("-{2,}"), "-").trim('-', '_')
            .take(60)
        if (cleaned.length >= 3) return cleaned
        return "model-${fallbackSha.take(12)}"
    }
}
