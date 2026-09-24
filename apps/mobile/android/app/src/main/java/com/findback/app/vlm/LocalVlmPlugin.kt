package com.findback.app.vlm

import android.content.Context
import android.content.SharedPreferences
import android.app.ActivityManager
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.os.Handler
import android.os.Looper
import com.findback.app.R
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import androidx.activity.result.ActivityResult
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

@CapacitorPlugin(name = "LocalVlm")
class LocalVlmPlugin : Plugin() {

    private val modelStates = ConcurrentHashMap<VlmModelId, VlmModelInfo>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val executor = Executors.newSingleThreadExecutor()

    // Initialized in load() after super.load(): getContext() is only valid
    // once the plugin is loaded, so no context-dependent work may happen in
    // init{} or lazy initializers.
    private var store: ModelStore? = null
    private var downloader: ModelDownloader? = null
    private var inspectionStore: PackageInspectionStore? = null
    private var prefs: SharedPreferences? = null
    private var expiryHandler: Handler? = null
    @Volatile private var initialized = false

    private val activeDownloads = ConcurrentHashMap<VlmModelId, Job>()
    private val candidateDownloads = ConcurrentHashMap<String, Job>()
    private val candidateDownloaders = ConcurrentHashMap<String, ModelDownloader>()
    private val candidateStates = ConcurrentHashMap<String, VlmState>()
    private val candidateErrors = ConcurrentHashMap<String, String>()
    private val candidateReady = ConcurrentHashMap.newKeySet<String>()
    private var currentMode: BackendMode = BackendMode.AUTO
    private var eventCollector: Job? = null
    /**
     * Explicit CPU compatibility permission for 500M analysis. Provisional
     * default ON; the beta device pass decides whether ON stays. CPU is
     * attempted only when GPU engine initialization fails — never for bad
     * input, cancelled work, or generation errors.
     */
    private var allowCpuFallback: Boolean = true

    // Single-resident warm engine lease (~60s idle TTL): the engine stays
    // loaded while the active report AI flow continues; each inference
    // refreshes the lease. Never keep both VLM engines resident together.
    private val warmLease = WarmEngineLease(
        clock = object : WarmEngineLease.Clock {
            override fun nowMs(): Long = System.currentTimeMillis()
        }
    )

    // Inference mutex to serialize inference calls
    private val inferenceMutex = InferenceMutex()

    // Cancellation token + native-running guard for the active inference.
    // Cancel only flips the token so the stale result is ignored; the mutex
    // stays held until the native analyze() returns (see finally below).
    private val activeInference = ActiveInferenceController()

    // Engine instances (initialized on demand, re-initialized after model changes)
    private var engine500: VlmEngine500? = null
    private var engine500IsCpu: Boolean = false
    private val engineLock = Any()

    // Qualified text runtime behind the explicit-modelId generateText bridge.
    // The lambdas resolve context/store lazily so construction never touches
    // getContext(); every invocation runs after ensureInitialized().
    private val textController = TextRuntimeController(
        engineFactory = { createQwenTextEngine() },
        isModelInstalled = { qwenModelFileIfPresent() != null }
    )

    // Text transfer lifecycle (Y owner, text-specific bridge keyed by the
    // exact qualified bridge id). Foreground chunk-engine download with the
    // same verified-promotion discipline as the image path; the image
    // scheduler, router, and `VlmModelId` channel are untouched.
    @Volatile private var textTransferState: VlmState = VlmState.NOT_INSTALLED
    private var textDownloadJob: Job? = null
    @Volatile private var lastTextSelfTestReady: Boolean = false

    // Single-residency arbiter over the image engine and the text
    // controller: acquiring one role evicts the other first through the
    // existing deferring release paths, never underneath native work.
    private val residencyArbiter = GenerativeResidencyArbiter(
        evictImage = {
            cancelLeaseExpiry()
            warmLease.releaseNow()
            if (activeInference.isNativeRunning()) {
                activeInference.cancel()
                activeInference.deferEngineRelease()
            } else {
                releaseEngine500()
            }
        },
        evictText = { textController.release() }
    )

    private fun requireStore(): ModelStore = store ?: throw IllegalStateException("Plugin not initialized")
    private fun requireDownloader(): ModelDownloader = downloader ?: throw IllegalStateException("Plugin not initialized")
    private fun requirePrefs(): SharedPreferences = prefs ?: throw IllegalStateException("Plugin not initialized")

    private fun candidateManifest(id: String?): ModelManifest? =
        PinnedModelSources.manifests.singleOrNull { it.id == id }

    /** SAF returns content URIs only; no received Intent is ever forwarded. */
    @PluginMethod
    fun pickImportPackage(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivityForResult(call, intent, "importPackagePicked")
    }

    @ActivityCallback
    private fun importPackagePicked(call: PluginCall, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            call.resolve(JSObject().put("cancelled", true))
            return
        }
        val uri = result.data?.data
        if (uri?.scheme != "content") {
            call.reject("Choose a document from the Android file picker", "INVALID_DOCUMENT")
            return
        }
        val response = JSObject()
        response.put("uri", uri.toString())
        val name = try {
            getContext().contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0)?.take(128) else null
            }
        } catch (_: Exception) { null }
        response.put("name", name ?: "model.fbmodel")
        call.resolve(response)
    }

    private fun isExportableEntry(id: String): Boolean =
        exportManifestFor(id) != null || isImportedEntry(id)

    private fun isImportedEntry(id: String): Boolean {
        if (!ImportCommitPolicy.isNamespacedEntryId(id)) return false
        return try {
            ImportedModelRegistry.list(requireStore().root).any { it.entryId == id }
        } catch (_: Exception) { false }
    }

    /**
     * A single directory choice writes separate checked packages, never a
     * combined archive. Bounded by [ExportSelectionPolicy]: 6 catalogue
     * slots plus up to 8 imported slots (14 total) so every installed
     * imported model stays selectable.
     */
    @PluginMethod
    fun exportSelectedModels(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val entryIds = try { call.getArray("entryIds")?.toList<String>() ?: emptyList() } catch (_: Exception) { emptyList() }
        if (!ExportSelectionPolicy.validate(entryIds, ::isExportableEntry)) {
            call.reject("Select installed catalogue or imported models to export", "ENTRY_MISMATCH")
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
        startActivityForResult(call, intent, "exportDirectoryPicked")
    }

    private fun exportManifestFor(entryId: String): ModelManifest? =
        KnownPackageIdentity.forCatalogueId(entryId)?.manifest ?: candidateManifest(entryId)

    @ActivityCallback
    private fun exportDirectoryPicked(call: PluginCall, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            call.resolve(JSObject().put("cancelled", true))
            return
        }
        val treeUri = result.data?.data
        if (treeUri?.scheme != "content" || !DocumentsContract.isTreeUri(treeUri)) {
            call.reject("Choose an Android document directory", "INVALID_DOCUMENT")
            return
        }
        val ids = try { call.getArray("entryIds")?.toList<String>() ?: emptyList() } catch (_: Exception) { emptyList() }
        scope.launch {
            val results = JSArray()
            try {
                val parent = DocumentsContract.buildDocumentUriUsingTree(treeUri, DocumentsContract.getTreeDocumentId(treeUri))
                for (id in ids) {
                    val row = JSObject()
                    row.put("entryId", id)
                    var destination: Uri? = null
                    try {
                        if (isImportedEntry(id)) {
                            val record = ImportedModelRegistry.list(requireStore().root).singleOrNull { it.entryId == id }
                                ?: throw IllegalStateException("Imported model not found")
                val installDir = ImportedModelRegistry.dirFor(requireStore().root, id)
                if (!installDir.isDirectory) throw IllegalStateException("Imported model files are missing")
                val trustedFiles = ImportedModelRegistry.verifiedExportFiles(requireStore().root, id)
                    ?: throw IllegalStateException("Imported model failed its installed hash check")
                            val fileName = "${ImportCommitPolicy.sanitizeFileStem(record.label, id)}.fbmodel"
                            row.put("fileName", fileName)
                            destination = DocumentsContract.createDocument(
                                getContext().contentResolver, parent, "application/octet-stream", fileName
                            ) ?: throw IllegalStateException("Could not create destination document")
                            val output = getContext().contentResolver.openOutputStream(destination, "w")
                                ?: throw IllegalStateException("Could not write destination document")
                            // Re-hashes installed bytes while streaming; only
                            // data-only packages with a weights artifact pass.
                            val exported = output.use { stream ->
                    PackageHost.exportPackage(id, installDir, stream, trustedFiles = trustedFiles)
                            }
                            if (!exported.ok) throw IllegalStateException(exported.reason ?: "Export failed")
                            row.put("ok", true)
                        } else {
                            val manifest = exportManifestFor(id) ?: continue
                            val name = "$id.fbmodel"
                            row.put("fileName", name)
                            if (!CandidateModelStatus.hasVerifiedWeights(requireStore(), manifest)) {
                                throw IllegalStateException("Installed model failed its hash check")
                            }
                            destination = DocumentsContract.createDocument(
                                getContext().contentResolver, parent, "application/octet-stream", name
                            ) ?: throw IllegalStateException("Could not create destination document")
                            val output = getContext().contentResolver.openOutputStream(destination, "w")
                                ?: throw IllegalStateException("Could not write destination document")
                            val exported = output.use { stream ->
                                PackageHost.exportPackage(id, requireStore().dirFor(manifest), stream, trustedFiles = manifest.files)
                            }
                            if (!exported.ok) throw IllegalStateException(exported.reason ?: "Export failed")
                            row.put("ok", true)
                        }
                    } catch (e: Exception) {
                        destination?.let { try { DocumentsContract.deleteDocument(getContext().contentResolver, it) } catch (_: Exception) { } }
                        row.put("ok", false)
                        row.put("reason", e.message ?: "Export failed")
                    }
                    results.put(row)
                }
                call.resolve(JSObject().put("results", results))
            } catch (_: Exception) {
                call.reject("The selected directory could not be used", "EXPORT_FAILED")
            }
        }
    }

    /**
     * Staged import inspection: a SAF content URI is staged and
     * data-only validated into a session without installing anything.
     * Known catalogue ids inspect here too (exact shipped package plus
     * interior pins, never an unknown fallback); unknown must be a
     * data-only schema-v1 bundle with exactly one `.litertlm`.
     * The UI must show the inspection summary and take an explicit
     * user confirmation before [commitInspectedPackage].
     */
    @PluginMethod
    fun inspectImportPackage(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val sourceUri = call.getString("sourceUri") ?: return call.reject("Missing sourceUri")
        val sessions = inspectionStore ?: return call.reject("Plugin not initialized")
        scope.launch {
            try {
                val uri = Uri.parse(sourceUri)
                if (uri?.scheme != "content") {
                    call.reject("Choose a document from the Android file picker", "INVALID_DOCUMENT")
                    return@launch
                }
                val inspected = getContext().contentResolver.openInputStream(uri)?.use { input ->
                    sessions.inspect(input, getFreeBytes())
                }
                if (inspected == null) {
                    call.reject(
                        "Package rejected: unreadable, oversized, failed validation, or a catalogue pin mismatch. Nothing installed.",
                        "IMPORT_REJECTED"
                    )
                    return@launch
                }
                val response = JSObject()
                response.put("inspectionId", inspected.id)
                response.put("entryId", inspected.manifest.entryId)
                response.put("packageSha256", inspected.packageSha256)
                response.put("unknown", inspected.unknown)
                response.put("manifest", inspected.manifest.toJSObject())
                call.resolve(response)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                call.reject("Import inspection failed: ${e.message}")
            }
        }
    }

    /**
     * Role-specific compatibility probe for a staged session: bounded
     * nonempty generation for the chosen role. Vision requires a
     * user-selected real image URI. Only an actual `OutOfMemoryError` or
     * a distinctly identified native allocation failure reports
     * `lowMemory`; every other error is incompatible and cannot be kept.
     * Metrics are measured only — never fabricated.
     */
    @PluginMethod
    fun probeInspectedPackage(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val inspectionId = call.getString("inspectionId") ?: return call.reject("Missing inspectionId")
        val role = call.getString("role")
        val imageUri = call.getString("imageUri")
        val sessions = inspectionStore ?: return call.reject("Plugin not initialized")
        val roleError = InspectedProbeClassifier.validateRole(role, imageUri)
        if (roleError != null) return call.reject("Choose Text or Images with a real test image", roleError)
        if (!inferenceMutex.tryAcquire()) return call.reject("Inference already in progress", "BUSY")
        scope.launch {
            try {
                val inspected = sessions.get(inspectionId)
                    ?: run { call.reject("Inspection session expired or not found", "IMPORT_REJECTED"); return@launch }
                val weightsFile = findStagedLitertlm(inspected.sandbox)
                    ?: run { call.reject("Staged model weights are missing", "IMPORT_REJECTED"); return@launch }
                // Probe in isolation from both resident production engines.
                textController.release()
                releaseEngine500()
                residencyArbiter.releaseAll()
                val memoryBefore = availableMemoryMb()
                val response = if (role == "Vision") {
                    probeVisionWeights(weightsFile, imageUri!!, memoryBefore)
                } else {
                    probeTextWeights(weightsFile, memoryBefore)
                }
                sessions.recordProbe(inspectionId, response.first, role!!)
                call.resolve(response.second)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                call.reject("Compatibility test failed: ${e.message}")
            } finally {
                inferenceMutex.release()
            }
        }
    }

    private fun probeTextWeights(weightsFile: File, memoryBefore: Long?): Pair<ProbeResult, JSObject> {
        val host = LiteRtQwenTextHost(weightsFile.absolutePath, getContext().cacheDir)
        return try {
            val loadStart = System.currentTimeMillis()
            host.initialize()
            val loadMs = System.currentTimeMillis() - loadStart
            val inferenceStart = System.currentTimeMillis()
            val text = host.generate("Name one item that could be lost.", 32, 0.1f)
            val inferenceMs = System.currentTimeMillis() - inferenceStart
            // A post-run free-memory sample is not a peak allocation measurement.
            val probe = InspectedProbeClassifier.classifySuccess(
                loadMs, inferenceMs, memoryBefore, null, text.isNotBlank()
            )
            probe to probeToJS(probe)
        } catch (e: OutOfMemoryError) {
            val probe = InspectedProbeClassifier.classifyFailure(e)
            probe to probeToJS(probe)
        } catch (e: Exception) {
            val probe = InspectedProbeClassifier.classifyFailure(e)
            probe to probeToJS(probe)
        } finally {
            try { host.close() } catch (_: Exception) { }
        }
    }

    private fun probeVisionWeights(weightsFile: File, imageUri: String, memoryBefore: Long?): Pair<ProbeResult, JSObject> {
        val engine = VlmEngine500(getContext(), weightsFile.absolutePath, getContext().cacheDir)
        return try {
            val loadStart = System.currentTimeMillis()
            engine.initialize()
            val loadMs = System.currentTimeMillis() - loadStart
            val inferenceStart = System.currentTimeMillis()
            val outcome = engine.runSelfTest(imageUri, "Describe this image briefly.")
            val inferenceMs = System.currentTimeMillis() - inferenceStart
            val probe = if (outcome.success) {
                InspectedProbeClassifier.classifySuccess(loadMs, inferenceMs, memoryBefore, null, true)
            } else if (outcome.failure == SelfTestFailure.INPUT_ERROR) {
                ProbeResult(false, false, loadMs, inferenceMs, memoryBefore, null, "INPUT_ERROR")
            } else {
                ProbeResult(false, false, loadMs, inferenceMs, memoryBefore, null, "INCOMPATIBLE")
            }
            probe to probeToJS(probe)
        } catch (e: OutOfMemoryError) {
            val probe = InspectedProbeClassifier.classifyFailure(e)
            probe to probeToJS(probe)
        } catch (e: Exception) {
            val probe = InspectedProbeClassifier.classifyFailure(e)
            probe to probeToJS(probe)
        } finally {
            try { engine.release() } catch (_: Exception) { }
        }
    }

    private fun probeToJS(probe: ProbeResult): JSObject {
        val obj = JSObject()
        obj.put("ready", probe.ready)
        obj.put("lowMemory", probe.lowMemory)
        probe.loadMs?.let { obj.put("loadMs", it) }
        probe.inferenceMs?.let { obj.put("inferenceMs", it) }
        probe.memoryBeforeMb?.let { obj.put("memoryBeforeMb", it) }
        probe.observedPeakMb?.let { obj.put("observedPeakMb", it) }
        probe.reason?.let { obj.put("reason", it) }
        return obj
    }

    private fun findStagedLitertlm(sandbox: File): File? {
        if (!sandbox.isDirectory) return null
        return try {
            sandbox.walkTopDown().filter { it.isFile && it.name.lowercase().endsWith(".litertlm") }.firstOrNull()
        } catch (_: Exception) { null }
    }

    /**
     * Commits a previously inspected session.
     *
     * Known branch promotes into the existing authoritative catalogue
     * store (exact shipped pins, never an Imported duplicate). Unknown
     * branch requires an explicit confirmed bounded `name`+`role` and a
     * recorded probe: success, or typed memory failure plus explicit
     * `keepUnverified`. Identity is namespaced by full package SHA-256;
     * unknown never auto-activates.
     */
    @PluginMethod
    fun commitInspectedPackage(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val inspectionId = call.getString("inspectionId") ?: return call.reject("Missing inspectionId")
        val sessions = inspectionStore ?: return call.reject("Plugin not initialized")
        scope.launch {
            try {
                sessions.pruneExpired()
                val inspected = sessions.get(inspectionId)
                    ?: return@launch call.reject("Inspection session expired or not found", "IMPORT_REJECTED")
                if (!inspected.unknown) {
                    // Locally re-exported catalogue packages re-enter here:
                    // route them back to their catalogue row via trusted
                    // native pins (never the unknown/imported path).
                    if (inspected.reexport) {
                        val trustedManifest = SixModelCatalogue.manifestForCatalogueId(inspected.manifest.entryId)?.let { shipped ->
                            ExportTrustStore.trustedFor(requireStore().root, inspected.manifest.entryId)?.let { tombstoned ->
                                shipped.copy(files = tombstoned)
                            } ?: shipped
                        } ?: return@launch call.reject("Catalogue pin missing for this package", PackageHost.Code.MISSING_PIN)
                        val recommitted = PackageCommitter.commitReexportedInspected(inspected, requireStore(), trustedManifest)
                        sessions.discard(inspectionId)
                        if (!recommitted.ok) {
                            call.reject(recommitted.reason ?: "Import failed", recommitted.code)
                            return@launch
                        }
                        recordReexportInstall(inspected.manifest.entryId, trustedManifest)
                        call.resolve(JSObject().put("ok", true).put("entryId", inspected.manifest.entryId))
                        return@launch
                    }
                    val known = KnownPackageIdentity.forCatalogueId(inspected.manifest.entryId)
                        ?: return@launch call.reject("Catalogue pin missing for this package", PackageHost.Code.MISSING_PIN)
                    val committed = PackageCommitter.commitKnownInspected(inspected, requireStore(), known)
                    sessions.discard(inspectionId)
                    if (!committed.ok) {
                        call.reject(committed.reason ?: "Import failed", committed.code)
                        return@launch
                    }
                    recordKnownInstall(known)
                    call.resolve(JSObject().put("ok", true).put("entryId", known.catalogueId))
                    return@launch
                }
                val name = call.getString("name")
                val role = call.getString("role")
                val description = call.getString("description")
                val keepUnverified = call.getBoolean("keepUnverified") == true
                val decision = ImportCommitPolicy.validateUnknown(
                    name, role, description, keepUnverified, inspected.lastProbe, inspected.probedRole
                )
                if (!decision.ok) {
                    call.reject(decision.reason ?: "Import refused", decision.code)
                    return@launch
                }
                val namespaced = ImportCommitPolicy.namespacedEntryId(inspected.packageSha256)!!
                val probe = inspected.lastProbe
                // Atomic unknown import: promotion + registry upsert are one
                // recoverable transaction (rollback on registry failure,
                // reconcile on retry after interruption).
                val atomicRecord = ImportedModelRegistry.Record(
                    entryId = namespaced,
                    label = name!!.trim(),
                    description = description?.take(ImportCommitPolicy.MAX_DESCRIPTION_CHARS),
                    role = role!!,
                    state = if (probe?.ready == true) ImportedModelRegistry.STATE_READY else ImportedModelRegistry.STATE_NOT_VERIFIED,
                    bytes = inspected.manifest.files.sumOf { it.bytes },
                    error = if (probe?.ready == true) null else probe?.reason,
                    loadMs = probe?.loadMs,
                    inferenceMs = probe?.inferenceMs,
                    memoryBeforeMb = probe?.memoryBeforeMb,
                    observedPeakMb = probe?.observedPeakMb,
                    packageSha256 = inspected.packageSha256.lowercase(),
                    manifestEntryId = inspected.manifest.entryId
                )
                val committed = PackageCommitter.commitUnknownAtomically(inspected, requireStore(), atomicRecord)
                if (!committed.ok) {
                    call.reject(committed.reason ?: "Import failed", committed.code)
                    return@launch
                }
                sessions.discard(inspectionId)
                call.resolve(JSObject().put("ok", true).put("entryId", namespaced))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                call.reject("Import failed: ${e.message}")
            }
        }
    }

    private fun recordKnownInstall(known: KnownPackageIdentity) {
        try {
            // Trust tombstone (verify time): verified artifact pins recorded
            // app-private so a later local re-export stays recognizable after
            // its container bytes change. Survives catalogue-row deletion.
            try {
                ExportTrustStore.record(requireStore().root, known.catalogueId, known.manifest.files)
            } catch (_: Exception) { }
            if (known.catalogueId == QwenTextRuntime.ENTRY_ID) {
                TextTransferStateStore.saveAtomic(
                    requireStore().textStateFile(known.catalogueId),
                    TextTransferState(
                        entryId = known.catalogueId,
                        revision = known.manifest.revision,
                        state = VlmState.INSTALLED_UNVERIFIED,
                        installedBytes = known.manifest.files.sumOf { it.expectedBytes },
                        installedSha256 = known.manifest.files.joinToString("") { it.sha256 },
                        installTimestamp = System.currentTimeMillis()
                    )
                )
            } else {
                val modelId = VlmModelId.fromWire(known.manifest.id) ?: return
                updateModelState(modelId, VlmState.INSTALLED_UNVERIFIED)
                persistModelState(modelId, known.manifest, VlmState.INSTALLED_UNVERIFIED)
            }
        } catch (_: Exception) { }
    }

    /**
     * Trust tombstone for a re-exported catalogue row: refreshes the
     * app-private artifact pins from the natively verified [manifest] so the
     * row stays re-exportable. Lifecycle state recording stays with the
     * existing known-install paths.
     */
    private fun recordReexportInstall(catalogueId: String, manifest: ModelManifest) {
        try {
            ExportTrustStore.record(requireStore().root, catalogueId, manifest.files)
        } catch (_: Exception) { }
    }
    /** Lists imported models from the persistent app-private registry. */
    @PluginMethod
    fun getImportedModels(call: PluginCall) {
        if (!ensureInitialized(call)) return
        scope.launch {
            try {
                val models = JSArray()
                for (record in ImportedModelRegistry.list(requireStore().root)) {
                    val obj = JSObject()
                    obj.put("entryId", record.entryId)
                    obj.put("label", record.label)
                    obj.put("description", record.description)
                    obj.put("role", record.role)
                    obj.put("state", record.state)
                    val dir = try { ImportedModelRegistry.dirFor(requireStore().root, record.entryId) } catch (_: Exception) { null }
                    obj.put("bytes", if (dir != null) ImportedModelRegistry.installedBytes(dir) else record.bytes)
                    record.error?.let { obj.put("error", it) }
                    record.loadMs?.let { obj.put("loadMs", it) }
                    record.inferenceMs?.let { obj.put("inferenceMs", it) }
                    record.memoryBeforeMb?.let { obj.put("memoryBeforeMb", it) }
                    record.observedPeakMb?.let { obj.put("observedPeakMb", it) }
                    models.put(obj)
                }
                call.resolve(JSObject().put("models", models))
            } catch (_: Exception) {
                call.reject("Could not read imported models")
            }
        }
    }

    /**
     * Deletes exactly one imported entry: files first (verified), then the
     * registry. A deletion failure returns its error with the registry
     * intact — never a silent partial delete.
     */
    @PluginMethod
    fun deleteImportedModel(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val entryId = call.getString("entryId") ?: return call.reject("Missing entryId")
        if (inferenceMutex.isHeld()) return call.reject("Model is in use", "BUSY")
        val deleted = ImportedModelRegistry.removeWithResult(requireStore().root, entryId)
        if (!deleted.ok) {
            return call.reject(deleted.reason ?: "Imported model not found", deleted.code)
        }
        call.resolve()
    }

    /** Discards an inspection session without installing anything. */
    @PluginMethod
    fun discardInspectedPackage(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val inspectionId = call.getString("inspectionId") ?: return call.reject("Missing inspectionId")
        inspectionStore?.discard(inspectionId)
        inspectionStore?.pruneExpired()
        call.resolve()
    }

    private fun updateCandidateState(id: String, state: VlmState, error: String? = null) {        candidateStates[id] = state
        if (error != null) candidateErrors[id] = error else candidateErrors.remove(id)
        if (state != VlmState.INSTALLED_UNVERIFIED) candidateReady.remove(id)
        val event = JSObject()
        event.put("entryId", id)
        event.put("state", state.wire)
        if (error != null) event.put("error", error)
        notifyListeners("candidateStateChange", event)
    }

    /** Candidate identity is the catalogue id, never an image-only VlmModelId or qualified Qwen id. */
    @PluginMethod
    fun getCandidateStates(call: PluginCall) {
        if (!ensureInitialized(call)) return
        scope.launch {
            try {
                val models = JSArray()
                for (manifest in PinnedModelSources.manifests) {
                    val installed = CandidateModelStatus.hasVerifiedWeights(requireStore(), manifest)
                    val transfer = candidateStates[manifest.id] ?: VlmState.NOT_INSTALLED
                    val info = JSObject()
                    info.put("entryId", manifest.id)
                    info.put("state", CandidateModelStatus.visibleState(installed, manifest.id in candidateReady, transfer))
                    info.put("installed", installed)
                    info.put("sizeBytes", manifest.files.single().expectedBytes)
                    val staged = requireStore().partFile(manifest, manifest.files.single())
                    info.put("downloadedBytes", if (staged.isFile) staged.length() else 0L)
                    candidateErrors[manifest.id]?.let { info.put("error", it) }
                    models.put(info)
                }
                val response = JSObject()
                response.put("models", models)
                call.resolve(response)
            } catch (_: Exception) {
                call.reject("Could not read model library status")
            }
        }
    }

    @PluginMethod
    fun downloadCandidateModel(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val manifest = candidateManifest(call.getString("entryId"))
            ?: return call.reject("Unknown candidate model", "ENTRY_MISMATCH")
        if (candidateDownloads.values.any { it.isActive } || activeDownloads.isNotEmpty() || textDownloadJob?.isActive == true) {
            return call.reject("Another download is in progress", "BUSY")
        }
        val downloader = ModelDownloader(getContext(), requireStore())
        candidateDownloaders[manifest.id] = downloader
        candidateReady.remove(manifest.id)
        updateCandidateState(manifest.id, VlmState.QUEUED)
        val job = scope.launch {
            try {
                val result = downloader.download(manifest,
                    onProgress = { downloaded, total ->
                        val event = JSObject()
                        event.put("entryId", manifest.id)
                        event.put("downloadedBytes", downloaded)
                        event.put("totalBytes", total)
                        notifyListeners("candidateDownloadProgress", event)
                    },
                    onState = { updateCandidateState(manifest.id, it) }
                )
                updateCandidateState(manifest.id, result,
                    if (result == VlmState.DOWNLOAD_FAILED) "Pinned source unavailable or rejected." else null)
                if (result == VlmState.INSTALLED_UNVERIFIED &&
                    CandidateModelStatus.hasVerifiedWeights(requireStore(), manifest)
                ) {
                    // Trust tombstone (download/verify time): verified
                    // artifact pins recorded app-private so a later local
                    // re-export stays recognizable. Survives row deletion.
                    try {
                        ExportTrustStore.record(requireStore().root, manifest.id, manifest.files)
                    } catch (_: Exception) { }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                updateCandidateState(manifest.id, VlmState.DOWNLOAD_FAILED, e.message ?: "Download failed")
            } finally {
                candidateDownloads.remove(manifest.id)
                candidateDownloaders.remove(manifest.id)
            }
        }
        candidateDownloads[manifest.id] = job
        call.resolve()
    }

    @PluginMethod
    fun pauseCandidateDownload(call: PluginCall) {
        val manifest = candidateManifest(call.getString("entryId"))
            ?: return call.reject("Unknown candidate model", "ENTRY_MISMATCH")
        val downloader = candidateDownloaders[manifest.id]
            ?: return call.reject("No active transfer to pause", "NOT_DOWNLOADING")
        downloader.requestPause()
        updateCandidateState(manifest.id, VlmState.PAUSING)
        call.resolve()
    }

    @PluginMethod
    fun cancelCandidateDownload(call: PluginCall) {
        val manifest = candidateManifest(call.getString("entryId"))
            ?: return call.reject("Unknown candidate model", "ENTRY_MISMATCH")
        val downloader = candidateDownloaders[manifest.id]
        if (downloader != null) {
            downloader.requestCancel(removePartial = true)
        } else {
            manifest.files.forEach { spec ->
                requireStore().partFile(manifest, spec).delete()
                requireStore().journalFile(manifest, spec).delete()
                requireStore().chunkTmpFile(manifest, spec).delete()
            }
            updateCandidateState(manifest.id, VlmState.NOT_INSTALLED)
        }
        call.resolve()
    }

    /** Verify means a real role-specific generation, never merely a successful hash. */
    @PluginMethod
    fun verifyCandidateModel(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val manifest = candidateManifest(call.getString("entryId"))
            ?: return call.reject("Unknown candidate model", "ENTRY_MISMATCH")
        if (!inferenceMutex.tryAcquire()) return call.reject("Inference already in progress", "BUSY")
        scope.launch {
            val started = System.currentTimeMillis()
            val memoryBefore = availableMemoryMb()
            try {
                if (!CandidateModelStatus.hasVerifiedWeights(requireStore(), manifest)) {
                    call.reject("Installed bytes failed integrity verification", "HASH_MISMATCH")
                    return@launch
                }
                val file = requireStore().finalFile(manifest, manifest.files.single())
                // Candidate probes are isolated from both resident production engines.
                textController.release()
                releaseEngine500()
                residencyArbiter.releaseAll()
                val isVision = manifest.id == "lfm2.5-vl-450m"
                val text: String
                val loadMs: Long
                val inferenceMs: Long
                if (isVision) {
                    val imageUri = call.getString("imageUri")
                    if (imageUri.isNullOrBlank()) {
                        call.reject("Choose a real image to verify this vision model", "INPUT_ERROR")
                        return@launch
                    }
                    val engine = VlmEngine500(getContext(), file.absolutePath, getContext().cacheDir)
                    try {
                        val loadStart = System.currentTimeMillis()
                        engine.initialize()
                        loadMs = System.currentTimeMillis() - loadStart
                        val result = engine.runSelfTest(imageUri, "Describe this image briefly.")
                        inferenceMs = System.currentTimeMillis() - loadStart - loadMs
                        if (!result.success) {
                            call.reject("Vision compatibility test failed", result.failure?.name ?: "GENERATION_ERROR")
                            return@launch
                        }
                        text = "Vision test generated usable output"
                    } finally {
                        engine.release()
                    }
                } else {
                    val host = LiteRtQwenTextHost(file.absolutePath, getContext().cacheDir)
                    try {
                        val loadStart = System.currentTimeMillis()
                        host.initialize()
                        loadMs = System.currentTimeMillis() - loadStart
                        val inferenceStart = System.currentTimeMillis()
                        text = host.generate("Name one item that could be lost.", 32, 0.1f)
                        inferenceMs = System.currentTimeMillis() - inferenceStart
                    } finally {
                        host.close()
                    }
                }
                if (text.isBlank()) {
                    call.reject("The model generated no usable output", "GENERATION_ERROR")
                    return@launch
                }
                candidateReady.add(manifest.id)
                // Trust tombstone (verify time): the on-device generation
                // proof above re-verified the installed bytes first, so these
                // pins are native-observed, never manifest-declared.
                try {
                    ExportTrustStore.record(requireStore().root, manifest.id, manifest.files)
                } catch (_: Exception) { }
                val response = JSObject()
                response.put("entryId", manifest.id)
                response.put("ready", true)
                response.put("observedOnThisDevice", true)
                response.put("loadMs", loadMs)
                response.put("inferenceMs", inferenceMs)
                if (memoryBefore != null) response.put("memoryBeforeMb", memoryBefore)
                availableMemoryMb()?.let { response.put("memoryAfterMb", it) }
                response.put("totalMs", System.currentTimeMillis() - started)
                call.resolve(response)
            } catch (_: OutOfMemoryError) {
                candidateReady.remove(manifest.id)
                call.reject("Not enough available memory to complete verification", "LOW_MEMORY")
            } catch (_: Exception) {
                candidateReady.remove(manifest.id)
                call.reject("This model could not run with this build", "INCOMPATIBLE")
            } finally {
                inferenceMutex.release()
            }
        }
    }

    private fun availableMemoryMb(): Long? = try {
        val service = getContext().getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val memory = ActivityManager.MemoryInfo()
        service.getMemoryInfo(memory)
        memory.availMem / (1024L * 1024L)
    } catch (_: Exception) { null }

    @PluginMethod
    fun deleteCandidateModel(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val manifest = candidateManifest(call.getString("entryId"))
            ?: return call.reject("Unknown candidate model", "ENTRY_MISMATCH")
        if (inferenceMutex.isHeld() || candidateDownloads[manifest.id]?.isActive == true) {
            return call.reject("Model is in use", "BUSY")
        }
        candidateReady.remove(manifest.id)
        if (!requireStore().dirFor(manifest).deleteRecursively() && requireStore().dirFor(manifest).exists()) {
            return call.reject("Could not delete model files", "DELETE_FAILED")
        }
        updateCandidateState(manifest.id, VlmState.NOT_INSTALLED)
        call.resolve()
    }

    /**
     * Diag sink directory, nullable so a torn-down plugin degrades
     * to untraced instead of throwing inside a diagnostics call.
     */
    private fun diagCacheDir(): File? {
        return try {
            getContext().cacheDir
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Rejects the call when load() has not completed yet.
     */
    private fun ensureInitialized(call: PluginCall): Boolean {
        if (!initialized || store == null || downloader == null || prefs == null) {
            call.reject("Plugin not initialized")
            return false
        }
        return true
    }

    /**
     * True when the 500M model file is present on disk. Used to distinguish a
     * vanished model (reject, no CPU attempt) from a GPU initialization
     * failure (explicit CPU compatibility when allowed).
     */
    private fun modelFileExists500(): Boolean {
        val manifest = MODEL_MANIFESTS.find { it.id == VlmModelId.SMOLVLM2_500M.wire } ?: return false
        val spec = manifest.files.firstOrNull() ?: return false
        return try {
            requireStore().finalFile(manifest, spec).exists()
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Returns the resident 500M engine, creating and genuinely initializing
     * it when absent. Initialization failures close the failed construction
     * and yield null, so a half-built engine is never stored or handed to
     * analyze() (audit #1: analyze() threw "Engine not initialized" after
     * restart / warm-lease expiry). Creation races keep the resident and
     * close the spare. Heavy GPU init must run off the caller thread: all
     * call sites invoke this from a background coroutine or collector.
     *
     * @param useCpu request the explicit CPU compatibility engine instead of
     * GPU. A resident engine built for the other backend is released first so
     * GPU and CPU engines are never resident together.
     */
    private fun initializeEngine500(useCpu: Boolean = false): VlmEngine500? {
        synchronized(engineLock) {
            engine500?.let { resident ->
                if (engine500IsCpu == useCpu) return resident
                try {
                    resident.release()
                } catch (_: Exception) {
                }
                engine500 = null
            }
        }
        val context = getContext()
        val manifest = MODEL_MANIFESTS.find { it.id == VlmModelId.SMOLVLM2_500M.wire } ?: return null
        val modelFile = manifest.files.firstOrNull()?.let { spec ->
            requireStore().finalFile(manifest, spec)
        }?.takeIf { it.exists() } ?: return null
        val backend = if (useCpu) VlmEngineBackend.CPU else VlmEngineBackend.GPU
        val fresh = acquireInitializedEngine(
            create = { VlmEngine500(context, modelFile.absolutePath, context.cacheDir, backend) },
            initialize = { it.initialize() },
            close = { it.release() }
        ) ?: return null
        synchronized(engineLock) {
            val existing = engine500
            return if (existing != null) {
                try {
                    fresh.release()
                } catch (_: Exception) {
                }
                existing
            } else {
                engine500 = fresh
                engine500IsCpu = useCpu
                fresh
            }
        }
    }

    private fun releaseEngine500() {
        engine500?.release()
        engine500 = null
        engine500IsCpu = false
    }

    private fun qwenModelFileIfPresent(): File? {
        val manifest = QwenTextRuntime.manifest()
        val spec = manifest.files.firstOrNull() ?: return null
        return try {
            requireStore().finalFile(manifest, spec).takeIf { it.exists() }
        } catch (_: Exception) {
            null
        }
    }

    private fun createQwenTextEngine(): QwenTextEngine? {
        val modelFile = qwenModelFileIfPresent() ?: return null
        val context = try {
            getContext()
        } catch (_: Exception) {
            return null
        } ?: return null
        val cacheDir = try {
            context.cacheDir
        } catch (_: Exception) {
            return null
        }
        return QwenTextEngine(
            hostFactory = { LiteRtQwenTextHost(modelFile.absolutePath, cacheDir) },
            diagCacheDir = cacheDir
        )
    }

    /**
     * Releases the resident engine when the warm-lease TTL expired.
     * Called on inference entry points and state reads so idle engines are
     * reclaimed without a timer, and Stage 1 -> Stage 2 stays warm.
     * Never releases underneath a running native inference.
     */
    private fun reclaimExpiredLease() {
        if (activeInference.isNativeRunning()) return
        val expired = warmLease.takeExpiredResident() ?: return
        releaseEngine500()
        residencyArbiter.release(GenerativeResidencyArbiter.ResidencyRole.IMAGE, expired.wire)
        notifyListeners("warmLeaseExpired", warmLeaseEvent(expired))
    }

    private fun warmLeaseEvent(modelId: VlmModelId): JSObject {
        val obj = JSObject()
        obj.put("modelId", modelId.wire)
        return obj
    }

    /**
     * Self-expiring lease: posts a Handler reclaim for the TTL deadline on
     * every acquire/refresh instead of polling with a timer.
     */
    private val leaseExpiryRunnable = Runnable {
        reclaimExpiredLease()
    }

    private fun scheduleLeaseExpiry() {
        val handler = expiryHandler ?: return
        handler.removeCallbacks(leaseExpiryRunnable)
        val delayMs = warmLease.timeUntilExpiryMs()
        if (delayMs > 0) {
            handler.postDelayed(leaseExpiryRunnable, delayMs)
        }
    }

    private fun cancelLeaseExpiry() {
        expiryHandler?.removeCallbacks(leaseExpiryRunnable)
    }

    override fun load() {
        super.load()
        // getContext() is valid from here on; nothing above may touch it.
        store = ModelStore.create(getContext())
        downloader = ModelDownloader(getContext(), requireStore())
        inspectionStore = PackageInspectionStore(
            File(getContext().filesDir, "package-inspections"),
            trustRoot = requireStore().root
        )
        // Startup staging recovery: prune abandoned private staging dirs
        // (older than TTL or unknown to live sessions — inspection sessions
        // are in-memory, so a restart orphans them on disk).
        try {
            inspectionStore?.reconcileStagingOnStartup()
        } catch (_: Exception) {
        }
        prefs = getContext().getSharedPreferences("findback_vlm", Context.MODE_PRIVATE)
        expiryHandler = Handler(Looper.getMainLooper())

        // Restore persisted mode.
        val modeWire = requirePrefs().getString("mode", null)
        modeWire?.let { BackendMode.fromWire(it)?.let { currentMode = it } }
        // Restore explicit CPU compatibility permission (default ON until the
        // beta device pass measures CPU latency/memory and locks the default).
        allowCpuFallback = requirePrefs().getBoolean("cpu_fallback_allowed", true)

        // Restore persisted model states. Transient transfer states are
        // reconciled against the real platform schedulers (not an in-memory
        // map, which is empty after process death) in a background pass
        // below; the UI starts from the persisted state and is corrected if
        // a live job is actually still owned by the system.
        for (manifest in MODEL_MANIFESTS) {
            val modelId = VlmModelId.fromWire(manifest.id) ?: continue
            val record = requireStore().loadRecord(modelId)
            // GPU verdicts are environment-bound (audit #3): a persisted
            // READY_GPU from a different app build / OS / ABI / revision /
            // runtime downgrades to INSTALLED_UNVERIFIED instead of being
            // trusted verbatim.
            val state = validatedRestoredState(
                record,
                manifest,
                appVersionName(),
                Build.FINGERPRINT,
                Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"
            )
            modelStates[modelId] = VlmModelInfo(modelId, state, record?.installedBytes)
        }
        // Restore the text transfer state. Transient transfer states with no
        // live job park as PAUSED (verified chunks staged for resume) or
        // NOT_INSTALLED; the text path has no platform scheduler to
        // reconcile against.
        val qwenManifest = QwenTextRuntime.manifest()
        val qwenSpec = qwenManifest.files.firstOrNull()
        val textRecord = try {
            QwenLifecycle.loadState(requireStore().root)
        } catch (_: Exception) {
            null
        }
        val textPartExists = try {
            qwenSpec != null && requireStore().partFile(qwenManifest, qwenSpec).exists()
        } catch (_: Exception) {
            false
        }
        textTransferState = QwenLifecycle.reconcileAtBoot(textRecord, textPartExists)
        initialized = true

        scope.launch {
            for (manifest in MODEL_MANIFESTS) {
                val modelId = VlmModelId.fromWire(manifest.id) ?: continue
                val live = try {
                    ModelDownloadScheduler.hasLiveJob(getContext(), modelId)
                } catch (_: Exception) {
                    false
                }
                val current = modelStates[modelId]?.state ?: continue
                val reconciled = TransferReconcile.reconcileState(current, live)
                if (reconciled != current) {
                    requireStore().saveTransferRecord(manifest, reconciled)
                    updateModelState(modelId, reconciled)
                }
            }
        }

        eventCollector?.cancel()
        eventCollector = scope.launch {
            TransferEvents.events.collect { event ->
                updateModelState(event.modelId, event.state, error = event.error)
                if (event.state == VlmState.DOWNLOADING && event.totalBytes > 0) {
                    val progress = event.downloadedBytes.toFloat() / event.totalBytes
                    notifyListeners(
                        "downloadProgress",
                        DownloadProgressEvent(event.modelId, progress, event.downloadedBytes, event.totalBytes).toJSObject()
                    )
                }
                if (event.state == VlmState.INSTALLED_UNVERIFIED && event.modelId == VlmModelId.SMOLVLM2_500M) {
                    residencyArbiter.acquireImage(VlmModelId.SMOLVLM2_500M.wire)
                    engine500 = initializeEngine500()
                    if (engine500 == null) {
                        residencyArbiter.release(GenerativeResidencyArbiter.ResidencyRole.IMAGE, VlmModelId.SMOLVLM2_500M.wire)
                    }
                }
            }
        }
    }

    @PluginMethod
    fun getCapabilities(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val context = getContext()
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"
        val androidVersion = Build.VERSION.RELEASE
        val apiLevel = Build.VERSION.SDK_INT
        val hardware = Build.HARDWARE
        val deviceCategory = if (Build.FINGERPRINT.contains("generic") || Build.HARDWARE.contains("goldfish") || Build.PRODUCT.contains("sdk")) {
            DeviceCategory.EMULATOR
        } else {
            DeviceCategory.PHYSICAL
        }
        val (gpuVendor, gpuRenderer) = GpuProbe.info()
        val memoryClassMb = (context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager).memoryClass
        val availableRamMb = availableRamMb(context)
        val freeAppStorageMb = getFreeAppStorageMb(context)
        val gpuDelegateClassPresent = GpuProbe.gpuDelegateClassPresent()
        val runtimeVersion = "0.16.0" // LiteRT version

        val capabilities = VlmCapabilities(
            abi = abi,
            androidVersion = androidVersion,
            apiLevel = apiLevel,
            hardware = hardware,
            deviceCategory = deviceCategory,
            gpuVendor = gpuVendor,
            gpuRenderer = gpuRenderer,
            memoryClassMb = memoryClassMb,
            freeAppStorageMb = freeAppStorageMb,
            availableRamMb = availableRamMb,
            gpuDelegateClassPresent = gpuDelegateClassPresent,
            runtimeVersion = runtimeVersion,
            appVersion = appVersionName(),
            buildGitSha = buildGitSha(),
            versionCode = appVersionCode()
        )
        val result = JSObject()
        result.put("capabilities", capabilities.toJSObject())
        call.resolve(result)
    }

    @PluginMethod
    fun getSettings(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val settings = VlmSettings(currentMode, allowCpuFallback)
        call.resolve(settings.toJSObject())
    }

    @PluginMethod
    fun setCpuFallback(call: PluginCall) {
        if (!ensureInitialized(call)) return
        // getBoolean returns false when absent; require the explicit key so a
        // malformed call cannot silently flip the default.
        if (!call.data.has("allowed")) {
            call.reject("Missing allowed")
            return
        }
        allowCpuFallback = call.getBoolean("allowed", true) == true
        requirePrefs().edit().putBoolean("cpu_fallback_allowed", allowCpuFallback).apply()
        // A resident engine built for the other path is stale: drop it so the
        // next analysis initializes the newly permitted backend.
        if (!allowCpuFallback && engine500IsCpu) {
            releaseEngine500()
            residencyArbiter.release(GenerativeResidencyArbiter.ResidencyRole.IMAGE)
        }
        call.resolve()
    }

    @PluginMethod
    fun setMode(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modeWire = call.getString("mode") ?: return
        BackendMode.fromWire(modeWire)?.let { mode ->
            currentMode = mode
            requirePrefs().edit().putString("mode", mode.wire).apply()
            call.resolve()
        } ?: call.reject("Invalid mode: $modeWire")
    }

    @PluginMethod
    fun getModelStates(call: PluginCall) {
        if (!ensureInitialized(call)) return
        // Build a real JS array; a Kotlin Array serializes as "[L...;@hash".
        // Prefer the live in-memory state (updated by transfers/self-tests)
        // over the persisted record so a just-passed test is visible now, not
        // only after the next restart. requiredBytes is the authoritative
        // native install requirement the UI gates Download on.
        val infos = VlmModelId.values().map { modelId ->
            val live = modelStates[modelId]
            val record = requireStore().loadRecord(modelId)
            val manifest = MODEL_MANIFESTS.single { it.id == modelId.wire }
            val requiredBytes = ModelInstallPolicy.requiredFreeBytes(
                manifest.files.sumOf { it.expectedBytes }
            )
            val state = live?.state ?: record?.state ?: VlmState.NOT_INSTALLED
            VlmModelInfo(
                modelId,
                state,
                record?.installedBytes ?: live?.sizeBytes,
                live?.error ?: record?.lastError?.message,
                requiredBytes
            )
        }
        val result = JSObject()
        result.put("models", modelStatesToJSArray(infos))
        call.resolve(result)
    }

    @PluginMethod
    fun downloadModel(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            val manifest = MODEL_MANIFESTS.single { it.id == modelId.wire }
            val currentState = modelStates[modelId]?.state ?: VlmState.NOT_INSTALLED
            if (currentState == VlmState.DOWNLOADING || currentState == VlmState.QUEUED ||
                currentState == VlmState.INSTALLED_UNVERIFIED || currentState == VlmState.READY_GPU
            ) {
                call.reject("Model already downloaded or downloading")
                return
            }

            // Publication gate: the catalogue stays authoritative — while the
            // distribution is UNPUBLISHED no scheduler work is queued and no
            // network fetch starts. Fail closed with the honest state.
            if (!ModelDownloader.isDownloadPermitted(manifest.distribution)) {
                updateModelState(modelId, VlmState.DOWNLOAD_FAILED, error = UNPUBLISHED_DISTRIBUTION_MESSAGE)
                call.reject(UNPUBLISHED_DISTRIBUTION_MESSAGE)
                return
            }

            // Check storage upfront
            val totalExpectedBytes = manifest.files.sumOf { it.expectedBytes }
            val freeBytes = getFreeBytes()
            if (!ModelInstallPolicy.canInstall(freeBytes, totalExpectedBytes)) {
                val error = ModelError(VlmErrorCode.INSUFFICIENT_STORAGE, "Insufficient storage space")
                updateModelState(modelId, VlmState.INSUFFICIENT_STORAGE, error = error.message)
                call.reject("Insufficient storage")
                return
            }

            TransferControls.setUserPaused(getContext(), modelId, false)
            updateModelState(modelId, VlmState.QUEUED)

            // Platform scheduler (UIDT on API 34+, WorkManager below) running
            // the shared chunk engine. Resolve immediately so the confirmation
            // dialog closes and progress/cancel UI stays visible.
            val scheduled = try {
                ModelDownloadScheduler.schedule(getContext(), modelId, networkPolicy(call))
            } catch (e: Exception) {
                false
            }
            if (scheduled) {
                call.resolve()
                return
            }

            // Foreground fallback must still honor Wi-Fi-only: never pull a
            // multi-hundred-MB model over a metered link without opt-in.
            if (networkPolicy(call) == ModelDownloadScheduler.NetworkPolicy.WIFI_ONLY && !isUnmetered()) {
                updateModelState(modelId, VlmState.WAITING_FOR_WIFI)
                call.reject("Waiting for Wi-Fi (enable Wi-Fi or allow cellular)")
                return
            }

            // Fallback: direct foreground download with the same chunk engine.
            val job = scope.launch {
                try {
                    updateModelState(modelId, VlmState.DOWNLOADING)
                    val finalState = requireDownloader().download(
                        manifest = manifest,
                        onProgress = { downloaded, total ->
                            val progress = if (total > 0) downloaded.toFloat() / total else 0f
                            notifyListeners("downloadProgress", DownloadProgressEvent(modelId, progress, downloaded, total).toJSObject())
                        },
                        onState = { transferState ->
                            if (transferState != VlmState.DOWNLOADING) {
                                updateModelState(modelId, transferState)
                            }
                        }
                    )
                    updateModelState(modelId, finalState)
                    if (finalState == VlmState.INSTALLED_UNVERIFIED) {
                        // Persist the installed state
                        persistModelState(modelId, manifest, finalState)
                        // Re-initialize engine if this is the 500M model
                        if (modelId == VlmModelId.SMOLVLM2_500M) {
                            residencyArbiter.acquireImage(VlmModelId.SMOLVLM2_500M.wire)
                            engine500 = initializeEngine500()
                            if (engine500 == null) {
                                residencyArbiter.release(GenerativeResidencyArbiter.ResidencyRole.IMAGE, VlmModelId.SMOLVLM2_500M.wire)
                            }
                        }
                    }
                    call.resolve()
                } catch (e: CancellationException) {
                    // Job cancelled (pause/cancel/teardown): not a failure.
                    // The scheduler path or a later resume owns the state.
                    throw e
                } catch (e: Exception) {
                    val error = ModelError(VlmErrorCode.DOWNLOAD_FAILED, e.message ?: "Download failed")
                    updateModelState(modelId, VlmState.DOWNLOAD_FAILED, error = error.message)
                    call.reject("Download failed: ${e.message}")
                } finally {
                    activeDownloads.remove(modelId)
                }
            }
            activeDownloads[modelId] = job
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun pauseDownload(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            // Graceful stop preserving verified chunks; the pause sticks
            // across scheduler restarts until resume.
            TransferControls.setUserPaused(getContext(), modelId, true)
            activeDownloads[modelId]?.let { requireDownloader().requestPause() }
            ModelDownloadScheduler.cancel(getContext(), modelId)
            updateModelState(modelId, VlmState.PAUSING)
            call.resolve()
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun resumeDownload(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            val currentState = modelStates[modelId]?.state ?: VlmState.NOT_INSTALLED
            if (currentState == VlmState.DOWNLOADING || currentState == VlmState.QUEUED) {
                call.reject("Download already in progress")
                return
            }
            TransferControls.setUserPaused(getContext(), modelId, false)
            updateModelState(modelId, VlmState.QUEUED)
            // Resume continues missing chunks only; verified ranges are kept.
            val scheduled = try {
                ModelDownloadScheduler.schedule(getContext(), modelId, networkPolicy(call))
            } catch (e: Exception) {
                false
            }
            if (!scheduled) {
                call.reject("Unable to schedule download")
                return
            }
            call.resolve()
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    /**
     * Repair path for REPAIR_NEEDED/CORRUPT/MANIFEST_MISMATCH: rescans chunks,
     * preserves good bytes, and re-fetches only bad ranges. Never loops
     * automatically on manifest mismatch.
     */
    @PluginMethod
    fun repairModel(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            TransferControls.setUserPaused(getContext(), modelId, false)
            updateModelState(modelId, VlmState.REPAIR_NEEDED)
            val scheduled = try {
                ModelDownloadScheduler.schedule(getContext(), modelId, networkPolicy(call))
            } catch (e: Exception) {
                false
            }
            if (!scheduled) {
                call.reject("Unable to schedule repair")
                return
            }
            call.resolve()
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        // Keep downloaded data for later (default) vs remove partial download.
        val removePartial = call.getBoolean("removePartial") ?: false
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            val job = activeDownloads.remove(modelId)
            requireDownloader().requestCancel(removePartial)
            job?.cancel()
            ModelDownloadScheduler.cancel(getContext(), modelId)
            val currentState = modelStates[modelId]?.state ?: VlmState.NOT_INSTALLED
            if (currentState == VlmState.DOWNLOADING || currentState == VlmState.QUEUED ||
                currentState == VlmState.PAUSING
            ) {
                if (removePartial) {
                    val manifest = MODEL_MANIFESTS.singleOrNull { it.id == modelId.wire }
                    if (manifest != null) {
                        for (spec in manifest.files) {
                            requireStore().partFile(manifest, spec).delete()
                            requireStore().journalFile(manifest, spec).delete()
                            requireStore().chunkTmpFile(manifest, spec).delete()
                        }
                    }
                    updateModelState(modelId, VlmState.NOT_INSTALLED)
                } else {
                    // Keep verified chunks for later resume.
                    updateModelState(modelId, VlmState.PAUSED)
                }
            }
            requireDownloader().resetControl()
            call.resolve()
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun deleteModel(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            // Never close the engine or delete files underneath a running
            // inference: reject BUSY so the UI can retry after completion.
            if (activeInference.isActive()) {
                call.reject("Inference in progress", "BUSY")
                return
            }
            // Confirmation is handled in UI; deletion here is exact and scoped:
            // unload engine, cancel transfer, remove only this model's
            // directory. The other model is unaffected.
            val job = activeDownloads.remove(modelId)
            requireDownloader().requestCancel(removePartial = true)
            job?.cancel()
            requireDownloader().resetControl()
            ModelDownloadScheduler.cancel(getContext(), modelId)
            TransferControls.setUserPaused(getContext(), modelId, false)

            // Delete model files from store (preserves other models)
            requireStore().deleteModel(modelId)

            // Release engine if it exists
            if (modelId == VlmModelId.SMOLVLM2_500M) {
                cancelLeaseExpiry()
                warmLease.releaseNow()
                releaseEngine500()
                residencyArbiter.release(GenerativeResidencyArbiter.ResidencyRole.IMAGE)
            }

            // Reset state
            updateModelState(modelId, VlmState.NOT_INSTALLED)
            call.resolve()
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    /**
     * Text-model lifecycle transfers (Y owner). Text-specific bridge keyed
     * by the exact qualified bridge id — any other id is rejected, never
     * substituted. Foreground chunk-engine download with verified
     * promotion into the authoritative `ModelStore` layout; no second
     * install root, no scheduler identity, no `VlmModelId` widening.
     * Residency and activation stay with the text controller (AB's
     * arbiter wraps acquisition when it lands).
     */
    @PluginMethod
    fun downloadTextModel(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        try {
            QwenTextRuntime.requireAcceptedModelId(modelIdWire)
        } catch (_: IllegalArgumentException) {
            call.reject("Invalid modelId: $modelIdWire")
            return
        }
        val manifest = QwenTextRuntime.manifest()
        if (textDownloadJob?.isActive == true || activeDownloads.isNotEmpty()) {
            call.reject("Another download is in progress")
            return
        }
        if (QwenLifecycle.isInstalledValid(requireStore().root, QwenLifecycle.loadState(requireStore().root))) {
            call.reject("Model already downloaded or downloading")
            return
        }
        if (textTransferState == VlmState.DOWNLOADING || textTransferState == VlmState.QUEUED) {
            call.reject("Model already downloaded or downloading")
            return
        }
        val totalExpectedBytes = manifest.files.sumOf { it.expectedBytes } +
            (manifest.distribution?.bytes ?: 0L)
        if (!ModelInstallPolicy.canInstall(getFreeBytes(), totalExpectedBytes)) {
            updateTextState(VlmState.INSUFFICIENT_STORAGE, error = "Insufficient storage space")
            call.reject("Insufficient storage")
            return
        }
        updateTextState(VlmState.QUEUED)
        textDownloadJob = scope.launch {
            try {
                runTextDownload(call)
            } catch (e: CancellationException) {
                // Pause/cancel/teardown own the state; never report failure.
                throw e
            } catch (e: Exception) {
                updateTextState(VlmState.DOWNLOAD_FAILED, error = e.message ?: "Download failed")
                try {
                    call.reject("Download failed: ${e.message}")
                } catch (_: Exception) {
                }
            } finally {
                if (textDownloadJob?.isCancelled == false) {
                    textDownloadJob = null
                }
            }
        }
    }

    private suspend fun runTextDownload(call: PluginCall) {
        val manifest = QwenTextRuntime.manifest()
        updateTextState(VlmState.DOWNLOADING)
        val finalState = requireDownloader().download(
            manifest = manifest,
            onProgress = { downloaded, total ->
                val progress = if (total > 0) downloaded.toFloat() / total else 0f
                val event = JSObject()
                event.put("modelId", QwenTextRuntime.BRIDGE_MODEL_ID)
                event.put("progress", progress)
                event.put("downloadedBytes", downloaded)
                event.put("totalBytes", total)
                notifyListeners("textDownloadProgress", event)
            },
            onState = { transferState ->
                if (transferState != VlmState.DOWNLOADING) {
                    updateTextState(transferState)
                }
            }
        )
        // A verified promotion is the only path to installed: the record
        // carries the asserted hash and the status derives installed from
        // record plus file facts, never from presence alone.
        updateTextState(finalState)
        call.resolve()
    }

    @PluginMethod
    fun pauseTextDownload(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        try {
            QwenTextRuntime.requireAcceptedModelId(modelIdWire)
        } catch (_: IllegalArgumentException) {
            call.reject("Invalid modelId: $modelIdWire")
            return
        }
        // Graceful stop preserving verified chunks; the PAUSED record
        // survives restarts until resume.
        requireDownloader().requestPause()
        textDownloadJob?.cancel()
        textDownloadJob = null
        requireDownloader().resetControl()
        updateTextState(VlmState.PAUSED)
        call.resolve()
    }

    @PluginMethod
    fun resumeTextDownload(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        try {
            QwenTextRuntime.requireAcceptedModelId(modelIdWire)
        } catch (_: IllegalArgumentException) {
            call.reject("Invalid modelId: $modelIdWire")
            return
        }
        if (textDownloadJob?.isActive == true ||
            textTransferState == VlmState.DOWNLOADING || textTransferState == VlmState.QUEUED
        ) {
            call.reject("Download already in progress")
            return
        }
        updateTextState(VlmState.QUEUED)
        // Resume continues missing chunks only; verified ranges are kept.
        textDownloadJob = scope.launch {
            try {
                runTextDownload(call)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                updateTextState(VlmState.DOWNLOAD_FAILED, error = e.message ?: "Download failed")
                try {
                    call.reject("Download failed: ${e.message}")
                } catch (_: Exception) {
                }
            } finally {
                if (textDownloadJob?.isCancelled == false) {
                    textDownloadJob = null
                }
            }
        }
    }

    @PluginMethod
    fun cancelTextDownload(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        // Keep downloaded data for later (default) vs remove partial download.
        val removePartial = call.getBoolean("removePartial") ?: false
        try {
            QwenTextRuntime.requireAcceptedModelId(modelIdWire)
        } catch (_: IllegalArgumentException) {
            call.reject("Invalid modelId: $modelIdWire")
            return
        }
        // Never cancel underneath a running generation: the transfer job
        // is stopped, native text code is untouched.
        textDownloadJob?.cancel()
        textDownloadJob = null
        requireDownloader().requestCancel(removePartial)
        requireDownloader().resetControl()
        if (textTransferState == VlmState.DOWNLOADING || textTransferState == VlmState.QUEUED ||
            textTransferState == VlmState.PAUSING || textTransferState == VlmState.PAUSED
        ) {
            if (removePartial) {
                val manifest = QwenTextRuntime.manifest()
                for (spec in manifest.files) {
                    requireStore().partFile(manifest, spec).delete()
                    requireStore().journalFile(manifest, spec).delete()
                    requireStore().chunkTmpFile(manifest, spec).delete()
                }
                updateTextState(VlmState.NOT_INSTALLED)
            } else {
                // Keep verified chunks for later resume.
                updateTextState(VlmState.PAUSED)
            }
        }
        call.resolve()
    }

    /**
     * Deletes exactly the qualified text model: cancels in-flight text
     * transfer, releases the resident text engine first (never deletes
     * files underneath running native code — rejects BUSY while text
     * code runs, mirroring image `deleteModel`), removes only this
     * entry's directory, and resets the transfer record. Sibling models
     * are unaffected.
     */
    @PluginMethod
    fun deleteTextModel(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        try {
            QwenTextRuntime.requireAcceptedModelId(modelIdWire)
        } catch (_: IllegalArgumentException) {
            call.reject("Invalid modelId: $modelIdWire")
            return
        }
        if (textController.isNativeRunning()) {
            call.reject("Inference in progress", "BUSY")
            return
        }
        textDownloadJob?.cancel()
        textDownloadJob = null
        requireDownloader().requestCancel(removePartial = true)
        requireDownloader().resetControl()
        // Release the resident engine before deleting its files.
        textController.release()
        lastTextSelfTestReady = false
        QwenLifecycle.deleteExactly(requireStore().root)
        updateTextState(VlmState.NOT_INSTALLED)
        call.resolve()
    }

    /**
     * Text transfer-state update: in-memory state, persisted record, and
     * the text-specific state event. The record carries the asserted
     * installed hash only for verified promotions; every other state
     * carries no hash so presence can never read as installed.
     */
    private fun updateTextState(state: VlmState, error: String? = null) {
        textTransferState = state
        val manifest = QwenTextRuntime.manifest()
        val spec = manifest.files.firstOrNull()
        var installedBytes = 0L
        var installedSha256 = ""
        if (state == VlmState.INSTALLED_UNVERIFIED && spec != null) {
            try {
                val final = requireStore().finalFile(manifest, spec)
                if (final.exists() && final.length() == spec.expectedBytes &&
                    Sha256.matchesFile(final, spec.sha256)
                ) {
                    installedBytes = spec.expectedBytes
                    installedSha256 = spec.sha256
                }
            } catch (_: Exception) {
            }
        }
        try {
            QwenLifecycle.saveState(
                requireStore().root,
                QwenTextStateRecord(
                    entryId = manifest.id,
                    revision = manifest.revision,
                    state = state,
                    installedBytes = installedBytes,
                    installTimestamp = System.currentTimeMillis(),
                    installedSha256 = installedSha256,
                    lastError = error
                )
            )
        } catch (_: Exception) {
        }
        val event = JSObject()
        event.put("modelId", QwenTextRuntime.BRIDGE_MODEL_ID)
        event.put("state", state.wire)
        error?.let { event.put("error", it) }
        notifyListeners("textStateChange", event)
    }

    /**
     * Streaming package import from a SAF content URI: the document stream
     * is staged with an incremental whole-package hash, ZIP entries are
     * validated into a temp staging dir, and on full success the staged
     * files are promoted into the authoritative `ModelStore` layout
     * (`root/<entryId>/<revision>/…`) with interior hashes re-verified
     * against the installed pins — never values from inside the package.
     * Staging is temp-only and always removed: no second installation
     * root survives. Any rejection leaves nothing installed. The
     * expected pin comes from the in-app shipped catalogue via the
     * caller — never from inside the package under test.
     */
    @PluginMethod
    fun importPackageFromUri(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val entryId = call.getString("entryId") ?: return call.reject("Missing entryId")
        val sourceUri = call.getString("sourceUri") ?: return call.reject("Missing sourceUri")
        val known = KnownPackageIdentity.forCatalogueId(entryId)
            ?: return call.reject("This model has no prepared package pin", PackageHost.Code.MISSING_PIN)
        val requestedPin = call.getString("expectedSha256")
        if (requestedPin != known.packageSha256) {
            return call.reject("The requested package pin differs from this build", PackageHost.Code.HASH_MISMATCH)
        }
        scope.launch {
            try {
                val manifest = known.manifest
                val uri = Uri.parse(sourceUri)
                val workDir = File(getContext().filesDir, "package-host")
                val stagingRoot = File(workDir, "staging-${System.nanoTime()}")
                try {
                    val staged = getContext().contentResolver.openInputStream(uri)?.use { input ->
                        PackageHost.importPackage(input, entryId, known.packageSha256, workDir, stagingRoot, getFreeBytes())
                    } ?: throw IllegalStateException("The document could not be opened.")
                    if (!staged.ok) {
                        call.reject(staged.reason ?: "Package rejected", staged.code)
                        return@launch
                    }
                    val store = requireStore()
                    if (!store.promoteValidatedSandbox(manifest, File(stagingRoot, entryId))) {
                        call.reject(
                            "Package interior does not match the installed pins for $entryId. Nothing installed.",
                            PackageHost.Code.HASH_MISMATCH
                        )
                        return@launch
                    }
                    if (entryId == QwenTextRuntime.ENTRY_ID) {
                        TextTransferStateStore.saveAtomic(
                            store.textStateFile(entryId),
                            TextTransferState(
                                entryId = entryId,
                                revision = manifest.revision,
                                state = VlmState.INSTALLED_UNVERIFIED,
                                installedBytes = manifest.files.sumOf { it.expectedBytes },
                                installedSha256 = manifest.files.joinToString("") { it.sha256 },
                                installTimestamp = System.currentTimeMillis()
                            )
                        )
                    } else {
                        val modelId = VlmModelId.fromWire(manifest.id)
                        if (modelId == null) {
                            call.reject(
                                "No lifecycle binding for catalogue entry: $entryId",
                                PackageHost.Code.ENTRY_MISMATCH
                            )
                            return@launch
                        }
                        updateModelState(modelId, VlmState.INSTALLED_UNVERIFIED)
                        persistModelState(modelId, manifest, VlmState.INSTALLED_UNVERIFIED)
                        if (modelId == VlmModelId.SMOLVLM2_500M) {
                            engine500 = initializeEngine500()
                        }
                    }
                    val response = JSObject()
                    response.put("ok", true)
                    response.put("manifest", staged.manifest?.toJSObject())
                    call.resolve(response)
                } finally {
                    stagingRoot.deleteRecursively()
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                call.reject("Import failed: ${e.message}")
            }
        }
    }

    /**
     * Streaming package export of the authoritative installed files for
     * [entryId] (`root/<entryId>/<revision>/…` — the same files the
     * runtime resolves) to a SAF destination URI. Only data-only
     * packages can be produced; writer failures resolve as rejections
     * with nothing claimed as packaged.
     */
    @PluginMethod
    fun exportPackageToUri(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val entryId = call.getString("entryId") ?: return call.reject("Missing entryId")
        val destUri = call.getString("destUri") ?: return call.reject("Missing destUri")
        scope.launch {
            try {
                val manifest = MODEL_MANIFESTS.singleOrNull { it.id == entryId }
                if (manifest == null) {
                    call.reject("Unknown catalogue entry: $entryId", PackageHost.Code.ENTRY_MISMATCH)
                    return@launch
                }
                val uri = Uri.parse(destUri)
                val installDir = requireStore().dirFor(manifest)
                val result = getContext().contentResolver.openOutputStream(uri)?.use { output ->
                    PackageHost.exportPackage(entryId, installDir, output)
                } ?: throw IllegalStateException("The destination could not be opened.")
                if (result.ok) {
                    val response = JSObject()
                    response.put("ok", true)
                    response.put("manifest", result.manifest?.toJSObject())
                    response.put("checksumsJson", result.checksumsJson)
                    call.resolve(response)
                } else {
                    call.reject(result.reason ?: "Export refused", result.code)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                call.reject("Export failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun embedTexts(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val textsArray = call.getArray("texts") ?: return
        val texts = mutableListOf<String>()
        for (i in 0 until textsArray.length()) {
            texts.add(textsArray.getString(i) ?: "")
        }

        // Try to acquire inference mutex
        if (!inferenceMutex.tryAcquire()) {
            call.reject("Inference already in progress", "MODEL_UNAVAILABLE")
            return
        }

        scope.launch {
            try {
                val embedder = UniversalSentenceEmbedder.getInstance(getContext())
                if (embedder == null) {
                    call.reject("Embedding model not available", "MODEL_UNAVAILABLE")
                    return@launch
                }

                val vectors = embedder.embedTexts(texts)
                val result = EmbedTextsResult(vectors)
                call.resolve(result.toJSObject())
            } catch (e: Exception) {
                val errorMsg = e.message ?: "Embedding failed"
                call.reject("Embedding failed: $errorMsg", "MODEL_UNAVAILABLE")
            } finally {
                inferenceMutex.release()
            }
        }
    }

    @PluginMethod
    fun runGpuSelfTest(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        val imageUri = call.getString("imageUri") // Optional image for real self-test
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            // A self-test is native inference too: it must serialize with
            // analyze() through the same mutex, or a test, a deletion and an
            // analysis can race each other.
            if (!inferenceMutex.tryAcquire()) {
                call.reject("Inference already in progress")
                return
            }
            val testToken = activeInference.begin()
            if (testToken == null) {
                inferenceMutex.release()
                call.reject("Inference already in progress")
                return
            }
            when (modelId) {
                VlmModelId.SMOLVLM2_500M -> {
                    val manifest = MODEL_MANIFESTS.single { it.id == modelId.wire }
                    residencyArbiter.acquireImage(modelId.wire)

                    scope.launch {
                        // Heavy GPU init runs here on IO, never on the
                        // plugin-method thread. Null means missing model
                        // file or failed engine init: settle and bail.
                        val engineInstance = initializeEngine500() ?: run {
                            residencyArbiter.release(GenerativeResidencyArbiter.ResidencyRole.IMAGE, modelId.wire)
                            activeInference.finishNative(testToken)
                            inferenceMutex.release()
                            val result = GpuSelfTestResult(GpuSelfTestState.GPU_UNAVAILABLE, "Model not installed")
                            call.resolve(result.toJSObject())
                            return@launch
                        }
                        try {
                            // A cancelled test must leave the pre-test state
                            // behind (audit #2): GPU_SELF_TESTING is transient
                            // and is never persisted on the cancel path.
                            val priorState = modelStates[modelId]?.state
                                ?: VlmState.INSTALLED_UNVERIFIED
                            updateModelState(modelId, VlmState.GPU_SELF_TESTING)
                            notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.GPU_SELF_TESTING).toJSObject())

                            val instruction = "Describe this image briefly."
                            activeInference.markNativeRunning(testToken, true)
                            val outcome = try {
                                engineInstance.runSelfTest(imageUri, instruction)
                            } finally {
                                activeInference.markNativeRunning(testToken, false)
                            }
                            val diagnostics = outcome.diagnostics

                            if (activeInference.isCancelled(testToken)) {
                                updateModelState(modelId, priorState)
                                notifyListeners("inferenceState", InferenceStateEvent(modelId, priorState).toJSObject())
                                call.reject("Self-test cancelled", "CANCELLED")
                                return@launch
                            }

                            if (outcome.success) {
                                persistModelState(modelId, manifest, VlmState.READY_GPU)
                                updateModelState(modelId, VlmState.READY_GPU)
                                notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU).toJSObject())
                                val result = GpuSelfTestResult(GpuSelfTestState.GPU_AVAILABLE)
                                call.resolve(result.toJSObject())
                            } else {
                                // Without image, leave as INSTALLED_UNVERIFIED; with image failure, mark error
                                val finalState = if (imageUri != null) {
                                    VlmState.GPU_UNAVAILABLE
                                } else {
                                    VlmState.INSTALLED_UNVERIFIED
                                }
                                persistModelState(modelId, manifest, finalState)
                                updateModelState(modelId, finalState, error = diagnostics.joinToString("; "))
                                notifyListeners("inferenceState", InferenceStateEvent(modelId, finalState, error = diagnostics.joinToString("; ")).toJSObject())
                                val result = GpuSelfTestResult(
                                    if (imageUri != null) GpuSelfTestState.GPU_UNAVAILABLE else GpuSelfTestState.GPU_UNSUPPORTED,
                                    diagnostics.joinToString("; "),
                                    outcome.failure
                                )
                                call.resolve(result.toJSObject())
                            }
                        } catch (e: Exception) {
                            updateModelState(modelId, VlmState.RUNTIME_ERROR, error = e.message)
                            notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.RUNTIME_ERROR, error = e.message).toJSObject())
                            val result = GpuSelfTestResult(
                                GpuSelfTestState.ERROR,
                                e.message,
                                SelfTestFailure.MODEL_RUNTIME_ERROR
                            )
                            call.resolve(result.toJSObject())
                        } finally {
                            activeInference.finishNative(testToken)
                            inferenceMutex.release()
                        }
                    }
                }
                VlmModelId.SMOLVLM_256M -> {
                    // Check if model files exist
                    val manifest = MODEL_MANIFESTS.single { it.id == modelId.wire }
                    val tfliteSpec = manifest.files.single { it.path.endsWith(".tflite") }
                    val tokenizerSpec = manifest.files.single { it.path == "tokenizer.model" }
                    val tfliteFile = requireStore().finalFile(manifest, tfliteSpec)
                    val tokenizerFile = requireStore().finalFile(manifest, tokenizerSpec)

                    if (!tfliteFile.exists() || !tokenizerFile.exists()) {
                        persistModelState(modelId, manifest, VlmState.GPU_UNAVAILABLE)
                        val result = GpuSelfTestResult(GpuSelfTestState.GPU_UNAVAILABLE, "Model files not found")
                        updateModelState(modelId, VlmState.GPU_UNAVAILABLE, error = "Model files not found")
                        notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.GPU_UNAVAILABLE, error = "Model files not found").toJSObject())
                        activeInference.finishNative(testToken)
                        inferenceMutex.release()
                        call.resolve(result.toJSObject())
                        return
                    }

                    scope.launch {
                        try {
                            updateModelState(modelId, VlmState.GPU_SELF_TESTING)
                            notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.GPU_SELF_TESTING).toJSObject())

                            val probe = Tflite256Probe(getContext(), requireStore(), ImagePreparer)
                            activeInference.markNativeRunning(testToken, true)
                            val (outcome, errorCode) = try {
                                probe.runProbe()
                            } finally {
                                activeInference.markNativeRunning(testToken, false)
                            }

                            if (activeInference.isCancelled(testToken)) {
                                call.reject("Self-test cancelled", "CANCELLED")
                                return@launch
                            }

                            persistModelState(modelId, manifest, outcome)
                            updateModelState(modelId, outcome, error = errorCode?.wire)
                            notifyListeners("inferenceState", InferenceStateEvent(modelId, outcome, error = errorCode?.wire).toJSObject())

                            val gpuSelfTestState = when (outcome) {
                                VlmState.READY_GPU -> GpuSelfTestState.GPU_AVAILABLE
                                else -> GpuSelfTestState.GPU_UNAVAILABLE
                            }
                            val result = GpuSelfTestResult(gpuSelfTestState, errorCode?.wire)
                            call.resolve(result.toJSObject())
                        } catch (e: Exception) {
                            updateModelState(modelId, VlmState.RUNTIME_ERROR, error = e.message)
                            notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.RUNTIME_ERROR, error = e.message).toJSObject())
                            val result = GpuSelfTestResult(GpuSelfTestState.ERROR, e.message)
                            call.resolve(result.toJSObject())
                        } finally {
                            activeInference.finishNative(testToken)
                            inferenceMutex.release()
                        }
                    }
                }
            }
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun analyzeImage(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modeWire = call.getString("mode") ?: run {
            call.reject("Missing mode")
            return
        }
        val mode = BackendMode.fromWire(modeWire) ?: run {
            call.reject("Invalid mode: $modeWire")
            return
        }
        val imageUri = call.getString("imageUri") ?: run {
            call.reject("Missing imageUri")
            return
        }
        val instruction = call.getString("instruction") ?: run {
            call.reject("Missing instruction")
            return
        }
        val maxOutputTokens = call.getInt("maxOutputTokens") ?: 224
        val temperature = call.getFloat("temperature") ?: 0.1f
        // Diagnostic trace: optional, propagated JS -> bridge -> native. Null
        // means untraced; Diag hooks no-op unless verbose logging is on.
        val traceId = call.getString("traceId")

        val selectedModel = VlmRouter.selectForAnalysis(mode, modelStates.mapValues { it.value.state })
        val modelId = when (selectedModel) {
            is AnalysisSelection.Ready -> selectedModel.modelId
            is AnalysisSelection.Unsupported -> {
                Diag.event(
                    diagCacheDir(),
                    "vlm.analyze.error",
                    traceId,
                    mapOf("stage" to "router", "reason" to "unsupported")
                )
                call.reject(selectedModel.reason)
                return
            }
        }

        // Check if model is ready
        val currentState = modelStates[modelId]?.state ?: VlmState.NOT_INSTALLED
        if (currentState != VlmState.READY_GPU) {
            Diag.event(
                diagCacheDir(),
                "vlm.analyze.error",
                traceId,
                mapOf("stage" to "router", "reason" to "model-not-ready", "state" to currentState.wire)
            )
            call.reject("Model not ready for inference. State: ${currentState.wire}")
            return
        }

        // Single-resident warm lease: Stage 1 -> Stage 2 stays warm, each
        // inference refreshes the ~60s TTL, model switch releases the old
        // engine. CPU compatibility is explicit, never silent: it engages only
        // when GPU engine initialization fails and the user allows it.
        reclaimExpiredLease()
        warmLease.acquire(modelId) { warmLease.releaseNow(); releaseEngine500() }
        scheduleLeaseExpiry()

        // Try to acquire inference mutex
        if (!inferenceMutex.tryAcquire()) {
            Diag.event(
                diagCacheDir(),
                "vlm.analyze.error",
                traceId,
                mapOf("stage" to "mutex", "reason" to "busy")
            )
            call.reject("Inference already in progress")
            notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.RUNTIME_ERROR, error = "Busy").toJSObject())
            return
        }
        // Cancellation token for this inference. cancelInference() flips the
        // token so the stale result is ignored, but the mutex stays held
        // until the native analyze() returns (released in finally below).
        val token = activeInference.begin()
        if (token == null) {
            Diag.event(
                diagCacheDir(),
                "vlm.analyze.error",
                traceId,
                mapOf("stage" to "mutex", "reason" to "busy")
            )
            inferenceMutex.release()
            call.reject("Inference already in progress")
            notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.RUNTIME_ERROR, error = "Busy").toJSObject())
            return
        }
        // Single generative residency: evict the text engine first when it
        // holds residency, then record the image entry.
        residencyArbiter.acquireImage(modelId.wire)

        scope.launch {
            var prepared: ImagePreparer.PreparedImage? = null
            val analyzeStartMs = System.currentTimeMillis()
            val diagDir = diagCacheDir()
            Diag.event(
                diagDir,
                "vlm.analyze.start",
                traceId,
                mapOf("modelId" to modelId.wire, "maxOutputTokens" to maxOutputTokens)
            )
            try {
                // Heavy engine init runs here on IO, after the READY check and
                // lease reclaim above. Null means either the model file
                // vanished (reject, no fallback) or GPU init failed (explicit
                // CPU compatibility when allowed). Failures after a successful
                // init — bad input, cancellation, generation errors — fail
                // closed and never trigger a CPU retry.
                notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU, phase = InferencePhase.LOADING_MODEL).toJSObject())
                val loadingStartMs = System.currentTimeMillis()
                var engineInstance = initializeEngine500(useCpu = false)
                var usedCpuFallback = false
                if (engineInstance == null) {
                    if (!modelFileExists500()) {
                        Diag.event(
                            diagDir,
                            "vlm.analyze.error",
                            traceId,
                            mapOf("stage" to "loading_model", "reason" to "model-file-missing")
                        )
                        residencyArbiter.release(GenerativeResidencyArbiter.ResidencyRole.IMAGE, modelId.wire)
                        call.reject("Model not installed or not ready")
                        notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU).toJSObject())
                        return@launch
                    }
                    if (!allowCpuFallback) {
                        Diag.event(
                            diagDir,
                            "vlm.analyze.error",
                            traceId,
                            mapOf("stage" to "loading_model", "reason" to "gpu-unavailable-cpu-off")
                        )
                        residencyArbiter.release(GenerativeResidencyArbiter.ResidencyRole.IMAGE, modelId.wire)
                        call.reject("GPU backend unavailable and CPU compatibility mode is off")
                        notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU).toJSObject())
                        return@launch
                    }
                    engineInstance = initializeEngine500(useCpu = true) ?: run {
                        Diag.event(
                            diagDir,
                            "vlm.analyze.error",
                            traceId,
                            mapOf("stage" to "loading_model", "reason" to "cpu-engine-start-failed")
                        )
                        residencyArbiter.release(GenerativeResidencyArbiter.ResidencyRole.IMAGE, modelId.wire)
                        call.reject("Inference failed: CPU compatibility engine could not start")
                        notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU).toJSObject())
                        return@launch
                    }
                    usedCpuFallback = true
                }
                Diag.event(
                    diagDir,
                    "vlm.analyze.phase",
                    traceId,
                    mapOf(
                        "phase" to "loading_model",
                        "modelId" to modelId.wire,
                        "backend" to engineInstance.backendName,
                        "usedCpuFallback" to usedCpuFallback,
                        "ms" to (System.currentTimeMillis() - loadingStartMs)
                    )
                )

                // Prepare image (temp file tracked for guaranteed cleanup).
                notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU, phase = InferencePhase.PREPARING_IMAGE).toJSObject())
                val prepareStartMs = System.currentTimeMillis()
                prepared = ImagePreparer.prepare(getContext(), imageUri, traceId)
                Diag.event(
                    diagDir,
                    "vlm.analyze.phase",
                    traceId,
                    mapOf(
                        "phase" to "preparing_image",
                        "modelId" to modelId.wire,
                        "ms" to (System.currentTimeMillis() - prepareStartMs)
                    )
                )

                // Run inference with the native-running flag held so
                // delete/release paths defer instead of closing underneath.
                notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU, phase = InferencePhase.RUNNING).toJSObject())
                activeInference.markNativeRunning(token, true)
                val runningStartMs = System.currentTimeMillis()
                val resultText = try {
                    engineInstance.analyze(prepared, instruction, maxOutputTokens, temperature, traceId)
                } finally {
                    activeInference.markNativeRunning(token, false)
                }
                val outputDigest = Diag.outputDigest(resultText)
                Diag.event(
                    diagDir,
                    "vlm.analyze.phase",
                    traceId,
                    outputDigest + mapOf(
                        "phase" to "running",
                        "modelId" to modelId.wire,
                        "backend" to engineInstance.backendName,
                        "ms" to (System.currentTimeMillis() - runningStartMs)
                    )
                )

                // A cancelled inference must settle the JS Promise: reject it so
                // the UI never waits forever on a call that will produce nothing.
                // The terminal phaseless event returns listeners to idle.
                if (activeInference.isCancelled(token)) {
                    Diag.event(
                        diagDir,
                        "vlm.analyze.cancelled",
                        traceId,
                        mapOf(
                            "modelId" to modelId.wire,
                            "ms" to (System.currentTimeMillis() - analyzeStartMs)
                        )
                    )
                    notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU).toJSObject())
                    call.reject("Inference cancelled", "CANCELLED")
                    return@launch
                }

                // Inference completed: refresh the warm lease.
                warmLease.refresh()
                scheduleLeaseExpiry()

                notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU, phase = InferencePhase.POSTPROCESSING).toJSObject())

                // Return result
                val result = AnalyzeResult(
                    text = resultText,
                    modelId = modelId,
                    backend = engineInstance.backendName,
                    runtime = "0.16.0",
                    diagnostics = if (usedCpuFallback) {
                        listOf("CPU compatibility mode: GPU backend unavailable on this runtime.")
                    } else {
                        emptyList()
                    }
                )
                call.resolve(result.toJSObject())
                Diag.event(
                    diagDir,
                    "vlm.analyze.done",
                    traceId,
                    outputDigest + mapOf(
                        "modelId" to modelId.wire,
                        "backend" to engineInstance.backendName,
                        "usedCpuFallback" to usedCpuFallback,
                        "ms" to (System.currentTimeMillis() - analyzeStartMs)
                    )
                )
                notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU).toJSObject())
            } catch (e: CancellationException) {
                // The job itself was cancelled: settle the call, then propagate.
                Diag.event(
                    diagDir,
                    "vlm.analyze.cancelled",
                    traceId,
                    mapOf(
                        "modelId" to modelId.wire,
                        "ms" to (System.currentTimeMillis() - analyzeStartMs)
                    )
                )
                try {
                    call.reject("Inference cancelled", "CANCELLED")
                } catch (_: Exception) {
                }
                throw e
            } catch (e: Exception) {
                if (!activeInference.isCancelled(token)) {
                    val errorMsg = e.message ?: "Inference failed"
                    Diag.event(
                        diagDir,
                        "vlm.analyze.error",
                        traceId,
                        mapOf(
                            "stage" to "inference",
                            "modelId" to modelId.wire,
                            "ms" to (System.currentTimeMillis() - analyzeStartMs),
                            "error" to errorMsg
                        )
                    )
                    call.reject("Inference failed: $errorMsg")
                    notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.RUNTIME_ERROR, error = errorMsg).toJSObject())
                }
            } finally {
                prepared?.let { ImagePreparer.cleanup(it) }
                val deferredRelease = activeInference.finishNative(token)
                inferenceMutex.release()
                if (deferredRelease) {
                    releaseEngine500()
                    residencyArbiter.release(GenerativeResidencyArbiter.ResidencyRole.IMAGE)
                }
            }
        }
    }

    /**
     * Explicit-modelId text generation against the qualified on-device text
     * runtime. The requested model id travels with every call and any id
     * other than the exact qualified entry is rejected, never substituted.
     * Serializes with image inference through the shared mutex; cancel and
     * release are shared with the image path (see below).
     */
    @PluginMethod
    fun generateText(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelId = call.getString("modelId") ?: run {
            call.reject("Missing modelId")
            return
        }
        val prompt = call.getString("prompt") ?: run {
            call.reject("Missing prompt")
            return
        }
        val maxOutputTokens = call.getInt("maxOutputTokens") ?: 256
        val temperature = call.getFloat("temperature") ?: 0.1f
        val traceId = call.getString("traceId")

        if (!inferenceMutex.tryAcquire()) {
            Diag.event(
                diagCacheDir(),
                "qwen.generate.error",
                traceId,
                mapOf("stage" to "mutex", "reason" to "busy")
            )
            call.reject("Inference already in progress")
            return
        }
        scope.launch {
            val startMs = System.currentTimeMillis()
            val diagDir = diagCacheDir()
            Diag.event(
                diagDir,
                "qwen.generate.start",
                traceId,
                mapOf("modelId" to modelId, "maxOutputTokens" to maxOutputTokens)
            )
            try {
                // Single generative residency: evict the image engine first
                // when it holds residency, then record the text entry. Only
                // the accepted id can create residency; anything else is
                // rejected inside the controller without touching it.
                if (QwenTextRuntime.isAcceptedModelId(modelId)) {
                    residencyArbiter.acquireText(modelId)
                }
                when (val outcome = textController.generateText(modelId, prompt, maxOutputTokens, temperature, traceId)) {
                    is TextGenerateOutcome.Ok -> {
                        val result = JSObject()
                        result.put("text", outcome.text)
                        result.put("modelId", modelId)
                        result.put("backend", outcome.backend)
                        result.put("runtime", "0.16.0")
                        call.resolve(result)
                        Diag.event(
                            diagDir,
                            "qwen.generate.done",
                            traceId,
                            Diag.outputDigest(outcome.text) + mapOf(
                                "modelId" to modelId,
                                "backend" to outcome.backend,
                                "ms" to (System.currentTimeMillis() - startMs)
                            )
                        )
                    }
                    is TextGenerateOutcome.Err -> {
                        Diag.event(
                            diagDir,
                            "qwen.generate.error",
                            traceId,
                            mapOf("modelId" to modelId, "code" to outcome.code, "error" to outcome.message)
                        )
                        // Residency means an actually resident initialized
                        // engine: drop the claim whenever no initialized text
                        // engine exists.
                        if (!textController.isReady()) {
                            residencyArbiter.release(GenerativeResidencyArbiter.ResidencyRole.TEXT, modelId)
                        }
                        call.reject(outcome.message, outcome.code)
                    }
                }
            } catch (e: CancellationException) {
                try {
                    call.reject("Text generation cancelled", "CANCELLED")
                } catch (_: Exception) {
                }
                throw e
            } catch (e: Exception) {
                call.reject("Text generation failed: ${e.message}")
            } finally {
                inferenceMutex.release()
            }
        }
    }

    /**
     * Runtime-ready probe for the text runtime: a real init plus a small
     * generation. Activation succeeds only when the returned state is
     * TEXT_READY; any other model id is rejected without touching the
     * runtime.
     */
    @PluginMethod
    fun runTextSelfTest(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelId = call.getString("modelId") ?: run {
            call.reject("Missing modelId")
            return
        }
        if (!inferenceMutex.tryAcquire()) {
            call.reject("Inference already in progress")
            return
        }
        scope.launch {
            try {
                if (QwenTextRuntime.isAcceptedModelId(modelId)) {
                    residencyArbiter.acquireText(modelId)
                }
                val result = textController.runSelfTest(modelId, "Describe the current task briefly.")
                // Residency means an actually resident initialized engine:
                // a self-test that cannot init leaves no TEXT resident.
                if (!textController.isReady()) {
                    residencyArbiter.release(GenerativeResidencyArbiter.ResidencyRole.TEXT, modelId)
                }
                // TEXT_READY proof for the lifecycle status: success plus
                // the canonical ready state. Any other outcome clears it.
                lastTextSelfTestReady =
                    result.ready && result.state == TextRuntimeController.STATE_READY
                val response = JSObject()
                response.put("modelId", modelId)
                response.put("ready", result.ready)
                response.put("state", result.state)
                result.failure?.let { response.put("failure", it.wire) }
                val diagnostics = JSArray()
                result.diagnostics.forEach { diagnostics.put(it) }
                response.put("diagnostics", diagnostics)
                call.resolve(response)
            } catch (e: CancellationException) {
                try {
                    call.reject("Self-test cancelled", "CANCELLED")
                } catch (_: Exception) {
                }
                throw e
            } catch (e: Exception) {
                call.reject("Self-test failed: ${e.message}")
            } finally {
                inferenceMutex.release()
            }
        }
    }

    /**
     * Diagnostics read for the text runtime: lifecycle-validated install,
     * file presence, TEXT_READY proof, residency, native activity, and
     * backend. Never initializes the runtime. `installed` is true only
     * for a verified promotion record plus matching file facts — a merely
     * present file reports `modelFilePresent` without `installed`.
     */
    @PluginMethod
    fun getTextRuntimeStatus(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val status = try {
            textController.status()
        } catch (e: Exception) {
            call.reject("Status read failed: ${e.message}")
            return
        }
        val record = try {
            QwenLifecycle.loadState(requireStore().root)
        } catch (_: Exception) {
            null
        }
        val installed = try {
            QwenLifecycle.isInstalledValid(requireStore().root, record)
        } catch (_: Exception) {
            false
        }
        val engineReady = textController.isReady()
        val response = JSObject()
        response.put("modelId", status.modelId)
        response.put("ready", status.ready)
        response.put("nativeRunning", status.nativeRunning)
        response.put("backend", status.backend)
        response.put("modelFilePresent", status.modelFilePresent)
        response.put("installed", installed)
        response.put("textReady", lastTextSelfTestReady && engineReady)
        if (engineReady) {
            response.put("residentModelId", QwenTextRuntime.BRIDGE_MODEL_ID)
        }
        call.resolve(response)
    }

    /**
     * Residency diagnostics for the later device proof: which entry, if any,
     * holds the single generative residency and in which role.
     */
    internal fun residencySnapshot(): GenerativeResidencyArbiter.ResidencySnapshot =
        residencyArbiter.snapshot()

    @PluginMethod
    fun cancelInference(call: PluginCall) {
        if (!ensureInitialized(call)) return
        // Best effort: flag the active inference cancelled so its eventual
        // result is ignored. The mutex stays held until the native analyze()
        // returns — never unlock early, never resolve the stale call.
        activeInference.cancel()
        textController.cancel()
        call.resolve()
    }

    @PluginMethod
    fun release(call: PluginCall) {
        if (!ensureInitialized(call)) return
        // Cancel all active downloads
        activeDownloads.values.forEach { it.cancel() }
        activeDownloads.clear()

        // Release engines + warm lease immediately (memory trim / teardown),
        // unless native inference is running: then flag cancel and defer the
        // engine close until the native call returns (see analyze finally).
        cancelLeaseExpiry()
        warmLease.releaseNow()
        if (activeInference.isNativeRunning()) {
            activeInference.cancel()
            activeInference.deferEngineRelease()
        } else {
            releaseEngine500()
        }
        // The text controller defers its own close while native text code
        // runs and cancels the in-flight generation first.
        textController.release()
        residencyArbiter.releaseAll()

        // Cancel the event collector and downloads, but never cancel the root
        // scope itself: a cancelled scope silently drops every later launch,
        // hanging subsequent calls forever. Resource release is below.
        eventCollector?.cancel()
        eventCollector = null

        call.resolve()
    }

    /**
     * Releases the warm engine lease immediately (leaving the AI flow,
     * memory trim, sustained background). The next inference re-acquires.
     */
    @PluginMethod
    fun releaseWarmLease(call: PluginCall) {
        if (!ensureInitialized(call)) return
        if (activeInference.isActive()) {
            call.reject("Inference in progress", "BUSY")
            return
        }
        cancelLeaseExpiry()
        warmLease.releaseNow()
        releaseEngine500()
        residencyArbiter.release(GenerativeResidencyArbiter.ResidencyRole.IMAGE)
        call.resolve()
    }

    private fun updateModelState(
        modelId: VlmModelId,
        state: VlmState,
        sizeBytes: Long? = null,
        error: String? = null
    ) {
        val info = VlmModelInfo(modelId, state, sizeBytes, error)
        modelStates[modelId] = info
        notifyListeners("modelStateChange", info.toJSObject())
    }

    private fun persistModelState(modelId: VlmModelId, manifest: ModelManifest, state: VlmState) {
        val files = manifest.files.map { spec ->
            val finalFile = requireStore().finalFile(manifest, spec)
            if (finalFile.exists() && finalFile.length() == spec.expectedBytes &&
                Sha256.matchesFile(finalFile, spec.sha256)
            ) {
                // Whole-file verified: report true bytes + hash.
                InstalledFileRecord(spec.path, spec.expectedBytes, finalFile.length(), spec.sha256, spec.sha256)
            } else {
                // Not verified: installed bytes are verified journal bytes
                // (never the preallocated .part length) and no installed SHA.
                val journal = TransferJournalStore.load(requireStore().journalFile(manifest, spec))
                InstalledFileRecord(
                    spec.path,
                    spec.expectedBytes,
                    TransferJournalStore.verifiedBytes(spec.expectedBytes, journal),
                    spec.sha256,
                    ""
                )
            }
        }
        val totalInstalledBytes = files.sumOf { it.installedBytes }
        val aggregateSha256 = files.joinToString("") { it.installedSha256 }
        val (gpuVendor, gpuRenderer) = GpuProbe.info()
        val record = ModelStateRecord(
            modelId = modelId,
            state = state,
            files = files,
            installedBytes = totalInstalledBytes,
            installTimestamp = System.currentTimeMillis(),
            runtimeVersion = manifest.runtime,
            appVersion = appVersionName(),
            fingerprint = Build.FINGERPRINT,
            abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown",
            gpuVendor = gpuVendor,
            gpuRenderer = gpuRenderer,
            revision = manifest.revision,
            sha256 = aggregateSha256,
            lastGpuSelfTest = if (state == VlmState.READY_GPU || state == VlmState.GPU_UNAVAILABLE) System.currentTimeMillis() else null,
            lastError = null
        )
        requireStore().saveRecord(record)
    }

    private fun appVersionName(): String {
        return try {
            val context = getContext()
            val info = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(context.packageName, android.content.pm.PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            info.versionName ?: "unknown"
        } catch (e: Exception) {
            "unknown"
        }
    }

    private fun buildGitSha(): String {
        return try {
            getContext().getString(R.string.findback_build_git_sha).ifBlank { "unknown" }
        } catch (e: Exception) {
            "unknown"
        }
    }

    private fun appVersionCode(): Int {
        return try {
            val context = getContext()
            @Suppress("DEPRECATION")
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            @Suppress("DEPRECATION")
            info.versionCode
        } catch (e: Exception) {
            0
        }
    }

    /**
     * Network policy for a transfer call. Defaults to Wi-Fi only; the JS
     * layer must explicitly pass `allowCellular: true` for the user's
     * Wi-Fi-or-cellular setting. Never silently downloads over metered links.
     */
    private fun networkPolicy(call: PluginCall): ModelDownloadScheduler.NetworkPolicy =
        if (call.getBoolean("allowCellular") == true) {
            ModelDownloadScheduler.NetworkPolicy.WIFI_OR_CELLULAR
        } else {
            ModelDownloadScheduler.NetworkPolicy.WIFI_ONLY
        }

    private fun isUnmetered(): Boolean {
        return try {
            val cm = getContext().getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
            val net = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(net) ?: return false
            caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        } catch (e: Exception) {
            false
        }
    }

    private fun getFreeBytes(): Long {
        val file = getContext().filesDir
        val stat = android.os.StatFs(file.path)
        return stat.availableBlocksLong * stat.blockSizeLong
    }

    private fun getFreeAppStorageMb(context: Context): Long {
        val file = context.filesDir
        val stat = android.os.StatFs(file.path)
        return (stat.availableBlocksLong * stat.blockSizeLong) / (1024 * 1024)
    }

    private fun availableRamMb(context: Context): Long? {
        return try {
            val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
            val info = android.app.ActivityManager.MemoryInfo()
            manager.getMemoryInfo(info)
            info.availMem / (1024 * 1024)
        } catch (e: Exception) {
            null
        }
    }
}

/**
 * Model state info for plugin events.
 */
/**
 * Wire array for getModelStates.
 *
 * Never pass a Kotlin `Array` to `JSObject.put`: Capacitor serializes it via
 * toString (e.g. "[Lcom.getcapacitor.JSObject;@1a2b3c"), which reaches JS as a
 * string and breaks array methods.
 */
internal fun modelStatesToJSArray(infos: List<VlmModelInfo>): JSArray {
    val arr = JSArray()
    infos.forEach { arr.put(it.toJSObject()) }
    return arr
}

/**
 * Serializes an observed package manifest for the `NativePackageHost`
 * seam. Every field is observed by the platform installer (import: from
 * the package manifest; export: from the streamed files, with empty
 * upstream metadata the installer does not carry). `exported` marks
 * locally re-exported packages (declared entryId + per-file hashes +
 * marker); official release packages carry false.
 */
internal fun PackageHost.Manifest.toJSObject(): JSObject {
    val obj = JSObject()
    obj.put("packageVersion", packageVersion)
    obj.put("entryId", entryId)
    obj.put("exported", exported)
    val upstream = JSObject()
    upstream.put("repo", upstreamRepo)
    upstream.put("rev", upstreamRev)
    upstream.put("file", upstreamFile)
    obj.put("upstream", upstream)
    obj.put("createdAt", createdAt)
    val files = JSArray()
    for (file in this.files) {
        val fileObj = JSObject()
        fileObj.put("path", file.path)
        fileObj.put("bytes", file.bytes)
        fileObj.put("sha256", file.sha256)
        fileObj.put("method", file.method)
        files.put(fileObj)
    }
    obj.put("files", files)
    return obj
}

data class VlmModelInfo(
    val id: VlmModelId,
    val state: VlmState,
    val sizeBytes: Long? = null,
    val error: String? = null,
    val requiredBytes: Long? = null
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        obj.put("id", id.wire)
        obj.put("state", state.wire)
        sizeBytes?.let { obj.put("sizeBytes", it) }
        error?.let { obj.put("error", it) }
        requiredBytes?.let { obj.put("requiredBytes", it) }
        return obj
    }
}
