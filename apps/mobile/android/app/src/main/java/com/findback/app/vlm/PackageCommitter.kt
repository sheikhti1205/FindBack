package com.findback.app.vlm

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Promotes a `PackageInspectionStore` session into the model library.
 *
 * Unknown branch: the staged package file is re-hashed and bound to the
 * inspection digest first, so exactly what was inspected is what gets
 * installed, plus a `provenance.json` carrying the package digest.
 * Identity is namespaced by the full package SHA-256 — never the
 * manifest-declared entry id — so a malicious manifest id can never
 * collide with or impersonate another entry.
 *
 * Known branch ([commitKnownInspected]): catalogue entries promote into
 * the existing authoritative `ModelStore` layout via
 * `promoteValidatedSandbox` against the shipped pins — never into
 * `imported/`. The SAF known-import transaction
 * (`LocalVlmPlugin.importPackageFromUri` → `PackageHost.importPackage` →
 * `ModelStore.promoteValidatedSandbox`) remains preserved; this is the
 * staged-inspection equivalent for the same pins.
 *
 * No Android framework dependencies; runs as JVM unit tests.
 */
object PackageCommitter {

    data class CommitResult(
        val ok: Boolean,
        val code: String? = null,
        val reason: String? = null
    )

    private fun refuse(code: String, reason: String) = CommitResult(false, code, reason)

    fun commitInspected(
        inspected: PackageInspectionStore.InspectedPackage,
        store: ModelStore
    ): CommitResult {
        if (!inspected.unknown) {
            return refuse(
                PackageHost.Code.ENTRY_MISMATCH,
                "Commit refused: catalogue entries must use the pinned known-import commit."
            )
        }
        val namespaced = ImportCommitPolicy.namespacedEntryId(inspected.packageSha256)
            ?: return refuse(PackageHost.Code.WHOLE_HASH_MISMATCH, "Commit refused: invalid package digest.")
        if (!inspected.packageFile.isFile ||
            !Sha256.ofFile(inspected.packageFile).equals(inspected.packageSha256, ignoreCase = true)
        ) {
            return refuse(
                PackageHost.Code.WHOLE_HASH_MISMATCH,
                "Commit refused: the staged package changed after inspection. Nothing installed."
            )
        }
        if (!inspected.sandbox.isDirectory) {
            return refuse(PackageHost.Code.MISSING_FILE, "Commit refused: the inspected session is gone.")
        }
        val target = File(store.root, "imported/$namespaced")
        if (target.exists()) {
            return refuse(
                PackageHost.Code.ENTRY_MISMATCH,
                "Commit refused: this exact package is already imported."
            )
        }
        return try {
            target.parentFile?.mkdirs()
            moveDir(inspected.sandbox, target)
            inspected.packageFile.delete()
            val provenance = JsonObject().apply {
                addProperty("entryId", namespaced)
                addProperty("manifestEntryId", inspected.manifest.entryId)
                addProperty("packageSha256", inspected.packageSha256)
                add("files", JsonArray().also { entries ->
                    inspected.manifest.files.forEach { spec ->
                        entries.add(JsonObject().apply {
                            addProperty("path", spec.path)
                            addProperty("bytes", spec.bytes)
                            addProperty("sha256", spec.sha256)
                        })
                    }
                })
            }
            File(target, "provenance.json").writeText(provenance.toString(), Charsets.UTF_8)
            CommitResult(true)
        } catch (_: Exception) {
            if (target.exists()) target.deleteRecursively()
            refuse(PackageHost.Code.CORRUPT_ARCHIVE, "Commit interrupted: the import could not be completed.")
        }
    }

    /**
     * Known branch: promotes a staged known session into the authoritative
     * catalogue layout. The whole-package digest and every interior pin
     * are re-checked against the shipped identity — never values from
     * inside the package under test.
     */
    fun commitKnownInspected(
        inspected: PackageInspectionStore.InspectedPackage,
        store: ModelStore,
        known: KnownPackageIdentity
    ): CommitResult {
        if (inspected.unknown) {
            return refuse(PackageHost.Code.ENTRY_MISMATCH, "Commit refused: unknown sessions cannot use the known commit.")
        }
        if (inspected.manifest.entryId != known.catalogueId) {
            return refuse(PackageHost.Code.ENTRY_MISMATCH, "Commit refused: catalogue entry mismatch.")
        }
        if (!inspected.packageSha256.equals(known.packageSha256, ignoreCase = true) ||
            !inspected.packageFile.isFile ||
            !Sha256.ofFile(inspected.packageFile).equals(known.packageSha256, ignoreCase = true)
        ) {
            return refuse(
                PackageHost.Code.WHOLE_HASH_MISMATCH,
                "Commit refused: the staged package does not match the shipped pin. Nothing installed."
            )
        }
        if (!inspected.sandbox.isDirectory) {
            return refuse(PackageHost.Code.MISSING_FILE, "Commit refused: the inspected session is gone.")
        }
        return try {
            val promoted = store.promoteValidatedSandbox(known.manifest, inspected.sandbox)
            if (!promoted) {
                return refuse(
                    PackageHost.Code.HASH_MISMATCH,
                    "Package interior does not match the installed pins for ${known.catalogueId}. Nothing installed."
                )
            }
            try {
                inspected.packageFile.delete()
            } catch (_: Exception) {
            }
            CommitResult(true)
        } catch (_: Exception) {
            refuse(PackageHost.Code.CORRUPT_ARCHIVE, "Commit interrupted: the import could not be completed.")
        }
    }

    private fun moveDir(source: File, dest: File) {
        try {
            Files.move(source.toPath(), dest.toPath(), StandardCopyOption.ATOMIC_MOVE)
        } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
            Files.move(source.toPath(), dest.toPath())
        }
    }
}
