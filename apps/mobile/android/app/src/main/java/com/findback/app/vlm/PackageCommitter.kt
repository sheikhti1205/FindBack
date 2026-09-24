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
 * collide with or impersonate another entry. Promotion and the registry
 * upsert belong to one recoverable transaction (see
 * [commitUnknownAtomically]): a registry-write failure after promotion
 * rolls the promoted files back, and a retry after an interruption
 * reconciles an existing target dir instead of hitting an
 * "already exists" dead-end.
 *
 * Known branch ([commitKnownInspected]): catalogue entries promote into
 * the existing authoritative `ModelStore` layout via
 * `promoteValidatedSandbox` against the shipped pins — never into
 * `imported/`. The SAF known-import transaction
 * (`LocalVlmPlugin.importPackageFromUri` → `PackageHost.importPackage` →
 * `ModelStore.promoteValidatedSandbox`) remains preserved; this is the
 * staged-inspection equivalent for the same pins.
 *
 * Re-export branch ([commitReexportedInspected]): locally re-exported
 * catalogue packages (export marker + trusted native pins) promote back
 * into the same authoritative catalogue row they were exported from.
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
            // Recoverable retry: an earlier attempt may have promoted the
            // same package (same SHA namespace) before an interruption ahead
            // of the registry write. An intact occupant reconciles as
            // success; a partial occupant is cleared for re-promotion —
            // never an "already exists" dead-end.
            if (targetMatchesInspected(target, inspected)) {
                ensureProvenance(target, inspected, namespaced)
                try {
                    inspected.packageFile.delete()
                } catch (_: Exception) {
                }
                return CommitResult(true)
            }
            try {
                target.deleteRecursively()
            } catch (_: Exception) {
            }
            if (target.exists()) {
                return refuse(
                    PackageHost.Code.ENTRY_MISMATCH,
                    "Commit refused: a conflicting import occupies this entry."
                )
            }
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
     * Atomic unknown import: file promotion + registry upsert as one
     * recoverable transaction. A registry-write failure after promotion
     * removes the promoted files (full rollback) and reports Import
     * failure; a retry after an interruption reconciles via
     * [commitInspected] and succeeds.
     */
    fun commitUnknownAtomically(
        inspected: PackageInspectionStore.InspectedPackage,
        store: ModelStore,
        record: ImportedModelRegistry.Record,
        registryWriter: (ImportedModelRegistry.Record) -> Unit = { ImportedModelRegistry.upsert(store.root, it) }
    ): CommitResult {
        val namespaced = ImportCommitPolicy.namespacedEntryId(inspected.packageSha256)
            ?: return refuse(PackageHost.Code.WHOLE_HASH_MISMATCH, "Commit refused: invalid package digest.")
        if (record.entryId != namespaced || record.packageSha256 != inspected.packageSha256.lowercase()) {
            return refuse(
                PackageHost.Code.ENTRY_MISMATCH,
                "Commit refused: the registry record does not match the inspected package."
            )
        }
        val promoted = commitInspected(inspected, store)
        if (!promoted.ok) return promoted
        return try {
            registryWriter(record)
            CommitResult(true)
        } catch (e: Exception) {
            try {
                val dir = File(store.root, "imported/$namespaced")
                if (dir.exists()) dir.deleteRecursively()
            } catch (_: Exception) {
            }
            refuse(
                PackageHost.Code.CORRUPT_ARCHIVE,
                "Import failed after promotion; the partial install was removed: ${e.message}"
            )
        }
    }

    private fun targetMatchesInspected(target: File, inspected: PackageInspectionStore.InspectedPackage): Boolean {
        return try {
            if (!target.isDirectory) return false
            inspected.manifest.files.all { spec ->
                val file = File(target, spec.path)
                file.isFile && file.length() == spec.bytes && Sha256.matchesFile(file, spec.sha256)
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun ensureProvenance(target: File, inspected: PackageInspectionStore.InspectedPackage, namespaced: String) {
        try {
            val provenanceFile = File(target, "provenance.json")
            if (provenanceFile.isFile) return
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
            provenanceFile.writeText(provenance.toString(), Charsets.UTF_8)
        } catch (_: Exception) {
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
            // Native-side trust tombstone (verify time): the verified artifact
            // pins are recorded app-private so a later local re-export of this
            // row is recognizable even though its container bytes differ.
            try {
                ExportTrustStore.record(store.root, known.catalogueId, known.manifest.files)
            } catch (_: Exception) {
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

    /**
     * Re-export branch: promotes a staged locally re-exported catalogue
     * session back into the same authoritative catalogue row it was exported
     * from. Verification is against [trustedManifest] — native-side pins
     * (shipped interiors or the app-private tombstone), never values from
     * inside the package under test. Records the trust tombstone on success
     * so the row stays re-exportable after future deletes.
     */
    fun commitReexportedInspected(
        inspected: PackageInspectionStore.InspectedPackage,
        store: ModelStore,
        trustedManifest: ModelManifest
    ): CommitResult {
        if (inspected.unknown || !inspected.reexport) {
            return refuse(
                PackageHost.Code.ENTRY_MISMATCH,
                "Commit refused: only inspected re-exported catalogue sessions can use the re-export commit."
            )
        }
        if (!SixModelCatalogue.isCatalogueId(inspected.manifest.entryId)) {
            return refuse(PackageHost.Code.ENTRY_MISMATCH, "Commit refused: not a catalogue entry.")
        }
        if (trustedManifest.files.isEmpty()) {
            return refuse(PackageHost.Code.MISSING_PIN, "Commit refused: no trusted pins for this entry.")
        }
        // The staged package is bound to its inspection digest first, so
        // exactly what was inspected is what gets installed.
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
        return try {
            val promoted = store.promoteValidatedSandbox(trustedManifest, inspected.sandbox)
            if (!promoted) {
                return refuse(
                    PackageHost.Code.HASH_MISMATCH,
                    "Package interior does not match the trusted pins for ${inspected.manifest.entryId}. Nothing installed."
                )
            }
            try {
                ExportTrustStore.record(store.root, inspected.manifest.entryId, trustedManifest.files)
            } catch (_: Exception) {
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
