package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class VlmTypesTest {

    @Test fun vlmModelIdOnlyTwoModels() {
        assertEquals(2, VlmModelId.values().size)
        assertEquals("smolvlm2-500m", VlmModelId.SMOLVLM2_500M.wire)
        assertEquals("smolvlm-256m", VlmModelId.SMOLVLM_256M.wire)
        assertNotNull(VlmModelId.fromWire("smolvlm2-500m"))
        assertNotNull(VlmModelId.fromWire("smolvlm-256m"))
        assertNull(VlmModelId.fromWire("smolvlm2-2b"))
        assertNull(VlmModelId.fromWire("gemma-3n-2b"))
    }

    @Test fun backendModeHasAutoFastQualityNoSpeed() {
        assertEquals(3, BackendMode.values().size)
        assertEquals("AUTO", BackendMode.AUTO.wire)
        assertEquals("FAST", BackendMode.FAST.wire)
        assertEquals("QUALITY", BackendMode.QUALITY.wire)
        assertNotNull(BackendMode.fromWire("AUTO"))
        assertNotNull(BackendMode.fromWire("FAST"))
        assertNotNull(BackendMode.fromWire("QUALITY"))
        assertNull(BackendMode.fromWire("SPEED"))
    }

    @Test fun vlmStateHasAllRequiredStatesNoCpuReady() {
        val states = VlmState.values().map { it.wire }.toSet()
        val expected = setOf(
            "NOT_INSTALLED", "QUEUED", "WAITING_FOR_NETWORK", "WAITING_FOR_WIFI",
            "DOWNLOADING", "PAUSING", "PAUSED", "PAUSED_ERROR",
            "VERIFYING_CHUNK", "VERIFYING_HASH", "VERIFYING_FILE",
            "REPAIR_NEEDED", "REPAIRING", "MANIFEST_MISMATCH",
            "INSTALLED_UNVERIFIED", "GPU_SELF_TESTING", "READY_GPU",
            "GPU_UNAVAILABLE", "CORRUPT", "INSUFFICIENT_STORAGE",
            "DOWNLOAD_FAILED", "RUNTIME_ERROR"
        )
        assertEquals(expected, states)
        assertNull(VlmState.fromWire("READY_CPU"))
        assertNull(VlmState.fromWire("NOT_DOWNLOADED"))
        assertNull(VlmState.fromWire("ERROR"))
    }

    @Test fun vlmErrorCodeHasRequiredCodes() {
        val codes = VlmErrorCode.values().map { it.wire }.toSet()
        val expected = setOf(
            "GPU_UNAVAILABLE_ON_CURRENT_RUNTIME", "DOWNLOAD_FAILED",
            "HASH_MISMATCH", "INSUFFICIENT_STORAGE", "RUNTIME_ERROR"
        )
        assertEquals(expected, codes)
    }

    @Test fun modelFileSpecHoldsPathBytesSha256() {
        val spec = ModelFileSpec("model.bin", 100L, "abc123")
        assertEquals("model.bin", spec.path)
        assertEquals(100L, spec.expectedBytes)
        assertEquals("abc123", spec.sha256)
    }

    @Test fun modelManifestHoldsAllFields() {
        val files = listOf(ModelFileSpec("model.bin", 100L, "abc123"))
        val manifest = ModelManifest(
            id = "test-model",
            sourceRepo = "org/repo",
            revision = "abcdef1234567890abcdef1234567890abcdef12",
            files = files,
            runtime = "com.example:runtime:1.0.0"
        )
        assertEquals("test-model", manifest.id)
        assertEquals("org/repo", manifest.sourceRepo)
        assertEquals("abcdef1234567890abcdef1234567890abcdef12", manifest.revision)
        assertEquals(files, manifest.files)
        assertEquals("com.example:runtime:1.0.0", manifest.runtime)
    }

    @Test fun modelErrorHoldsCodeAndMessage() {
        val error = ModelError(VlmErrorCode.HASH_MISMATCH, "Hash mismatch")
        assertEquals(VlmErrorCode.HASH_MISMATCH, error.code)
        assertEquals("Hash mismatch", error.message)
    }

    @Test fun installedFileRecordHoldsAllFields() {
        val record = InstalledFileRecord(
            path = "model.bin",
            expectedBytes = 100L,
            installedBytes = 100L,
            expectedSha256 = "abc123",
            installedSha256 = "abc123"
        )
        assertEquals("model.bin", record.path)
        assertEquals(100L, record.expectedBytes)
        assertEquals(100L, record.installedBytes)
        assertEquals("abc123", record.expectedSha256)
        assertEquals("abc123", record.installedSha256)
    }

    @Test fun modelStateRecordHoldsAllFieldsWithNullableGpuAndError() {
        val files = listOf(InstalledFileRecord("model.bin", 100L, 100L, "abc123", "abc123"))
        val error = ModelError(VlmErrorCode.DOWNLOAD_FAILED, "Network error")
        val record = ModelStateRecord(
            modelId = VlmModelId.SMOLVLM2_500M,
            state = VlmState.READY_GPU,
            files = files,
            installedBytes = 100L,
            installTimestamp = 1234567890L,
            runtimeVersion = "0.16.0",
            appVersion = "1.0.0",
            fingerprint = "fp123",
            abi = "arm64-v8a",
            gpuVendor = "Qualcomm",
            gpuRenderer = "Adreno 730",
            revision = "abcdef1234567890abcdef1234567890abcdef12",
            sha256 = "abc123",
            lastGpuSelfTest = 1234567890L,
            lastError = error
        )
        assertEquals(VlmModelId.SMOLVLM2_500M, record.modelId)
        assertEquals(VlmState.READY_GPU, record.state)
        assertEquals(files, record.files)
        assertEquals(100L, record.installedBytes)
        assertEquals(1234567890L, record.installTimestamp)
        assertEquals("0.16.0", record.runtimeVersion)
        assertEquals("1.0.0", record.appVersion)
        assertEquals("fp123", record.fingerprint)
        assertEquals("arm64-v8a", record.abi)
        assertEquals("Qualcomm", record.gpuVendor)
        assertEquals("Adreno 730", record.gpuRenderer)
        assertEquals("abcdef1234567890abcdef1234567890abcdef12", record.revision)
        assertEquals("abc123", record.sha256)
        assertEquals(1234567890L, record.lastGpuSelfTest)
        assertEquals(error, record.lastError)

        // Test with nulls
        val recordNulls = ModelStateRecord(
            modelId = VlmModelId.SMOLVLM_256M,
            state = VlmState.NOT_INSTALLED,
            files = emptyList(),
            installedBytes = 0L,
            installTimestamp = 0L,
            runtimeVersion = "",
            appVersion = "",
            fingerprint = "",
            abi = "",
            gpuVendor = null,
            gpuRenderer = null,
            revision = "",
            sha256 = "",
            lastGpuSelfTest = null,
            lastError = null
        )
        assertNull(recordNulls.gpuVendor)
        assertNull(recordNulls.gpuRenderer)
        assertNull(recordNulls.lastGpuSelfTest)
        assertNull(recordNulls.lastError)
    }

    @Test fun vlmCapabilitiesHoldsAllDeviceInfo() {
        val caps = VlmCapabilities(
            abi = "arm64-v8a",
            androidVersion = "14",
            apiLevel = 34,
            hardware = "pixel",
            deviceCategory = DeviceCategory.PHYSICAL,
            gpuVendor = "Qualcomm",
            gpuRenderer = "Adreno 730",
            memoryClassMb = 256,
            freeAppStorageMb = 1024L,
            gpuRuntimePresent = true,
            runtimeVersion = "0.16.0"
        )
        assertEquals("arm64-v8a", caps.abi)
        assertEquals("14", caps.androidVersion)
        assertEquals(34, caps.apiLevel)
        assertEquals("pixel", caps.hardware)
        assertEquals(DeviceCategory.PHYSICAL, caps.deviceCategory)
        assertEquals("Qualcomm", caps.gpuVendor)
        assertEquals("Adreno 730", caps.gpuRenderer)
        assertEquals(256, caps.memoryClassMb)
        assertEquals(1024L, caps.freeAppStorageMb)
        assertTrue(caps.gpuRuntimePresent)
        assertEquals("0.16.0", caps.runtimeVersion)
    }

    @Test fun vlmSettingsHoldsMode() {
        val settings = VlmSettings(BackendMode.FAST)
        assertEquals(BackendMode.FAST, settings.mode)
    }

    @Test fun analyzeRequestHoldsAllFields() {
        val request = AnalyzeRequest(
            mode = BackendMode.QUALITY,
            imageUri = "content://image.jpg",
            instruction = "Describe this image",
            maxOutputTokens = 224,
            temperature = 0.1f
        )
        assertEquals(BackendMode.QUALITY, request.mode)
        assertEquals("content://image.jpg", request.imageUri)
        assertEquals("Describe this image", request.instruction)
        assertEquals(224, request.maxOutputTokens)
        assertEquals(0.1f, request.temperature)
    }

    @Test fun analyzeResultHoldsAllFields() {
        val result = AnalyzeResult(
            text = "A cat on a mat",
            modelId = VlmModelId.SMOLVLM2_500M,
            backend = "gpu",
            runtime = "0.16.0",
            diagnostics = listOf("diag1", "diag2")
        )
        assertEquals("A cat on a mat", result.text)
        assertEquals(VlmModelId.SMOLVLM2_500M, result.modelId)
        assertEquals("gpu", result.backend)
        assertEquals("0.16.0", result.runtime)
        assertEquals(listOf("diag1", "diag2"), result.diagnostics)
    }

    @Test fun analyzeResultSerializesDiagnosticsAsJsonArray() {
        val result = AnalyzeResult(
            text = "t",
            modelId = VlmModelId.SMOLVLM2_500M,
            backend = "gpu",
            runtime = "0.16.0",
            diagnostics = listOf("diag1", "diag2"),
        )
        // getJSONArray throws if diagnostics were serialized as a string.
        val arr = result.toJSObject().getJSONArray("diagnostics")
        assertEquals(2, arr.length())
        assertEquals("diag1", arr.getString(0))
    }

    @Test fun embedTextsResultSerializesVectorsAsNestedJsonArray() {
        val result = EmbedTextsResult(listOf(listOf(0.1f, 0.2f), listOf(0.3f, 0.4f)))
        val outer = result.toJSObject().getJSONArray("vectors")
        assertEquals(2, outer.length())
        val inner = outer.getJSONArray(0)
        assertEquals(2, inner.length())
        assertEquals(0.1, inner.getDouble(0), 1e-6)
        assertEquals(0.4, outer.getJSONArray(1).getDouble(1), 1e-6)
    }
}