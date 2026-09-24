package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CandidateRuntimeControllerTest {

    private val prepared = ImagePreparer.PreparedImage("/tmp/prepared.jpg", temporary = true)

    private class FakeVision {
        var initialized = false
        var released = false
        var lastInstruction: String? = null
    }

    private class FakeText {
        var initialized = false
        var released = false
        var cancelled = false
        var lastPrompt: String? = null
    }

    private fun visionHandle(fake: FakeVision) = CandidateRuntimeController.VisionHandle(
        initialize = { fake.initialized = true },
        run = { _, instruction, _, _, _ ->
            fake.lastInstruction = instruction
            "vision-output"
        },
        release = { fake.released = true }
    )

    private fun textHandle(fake: FakeText) = CandidateRuntimeController.TextHandle(
        initialize = { fake.initialized = true },
        run = { prompt, _, _ ->
            fake.lastPrompt = prompt
            "text-output"
        },
        cancel = { fake.cancelled = true },
        release = { fake.released = true }
    )

    @Test
    fun roleForDistinguishesVisionTextAndNonCandidates() {
        assertEquals(
            CandidateRuntimeController.Role.IMAGE,
            CandidateRuntimeController.roleFor(CandidateRuntimeController.VISION_ENTRY)
        )
        for (id in listOf(
            "qwen3-0.6b-litert-mixed-int4",
            "qwen3-0.6b-litert-int8",
            "lfm2.5-1.2b-instruct-litert-int4-gpu"
        )) {
            assertEquals(CandidateRuntimeController.Role.TEXT, CandidateRuntimeController.roleFor(id), id)
        }
        // The two recommended entries are never candidates.
        assertNull(CandidateRuntimeController.roleFor("smolvlm2-500m-litert-int4"))
        assertNull(CandidateRuntimeController.roleFor("qwen3-0.6b-litert-dynamic-int4"))
    }

    @Test
    fun activatesImageCandidateAndRunsVisionInference() {
        val runtime = CandidateRuntimeController()
        val vision = FakeVision()
        runtime.activateImage(CandidateRuntimeController.VISION_ENTRY, visionHandle(vision))

        assertTrue(vision.initialized)
        assertEquals(CandidateRuntimeController.VISION_ENTRY, runtime.residentEntryId())
        assertEquals(CandidateRuntimeController.Role.IMAGE, runtime.residentRole())
        assertTrue(runtime.isActive(CandidateRuntimeController.VISION_ENTRY))
        assertEquals(
            CandidateRuntimeController.VISION_ENTRY,
            runtime.residentImageEntryId()
        )
        assertNull(runtime.residentTextEntryId())

        val text = runtime.analyzeImage(prepared, "describe", 32, 0.1f, null)
        assertEquals("vision-output", text)
        assertEquals("describe", vision.lastInstruction)

        runtime.release()
        assertTrue(vision.released)
        assertNull(runtime.residentEntryId())
        assertFalse(runtime.isActive(CandidateRuntimeController.VISION_ENTRY))
    }

    @Test
    fun activatesTextCandidateAndRunsTextInferenceForItsEntryOnly() {
        val runtime = CandidateRuntimeController()
        val text = FakeText()
        val entryId = "qwen3-0.6b-litert-int8"
        runtime.activateText(entryId, textHandle(text))

        assertTrue(text.initialized)
        assertEquals(entryId, runtime.residentTextEntryId())
        assertEquals("text-output", runtime.generateText(entryId, "hello", 16, 0.1f))
        assertEquals("hello", text.lastPrompt)
        // A different entry can never ride the resident text candidate.
        assertFailsWith<IllegalStateException> {
            runtime.generateText("qwen3-0.6b-litert-mixed-int4", "hello", 16, 0.1f)
        }
    }

    @Test
    fun analyzeImageThrowsWhenNoImageCandidateIsResident() {
        val runtime = CandidateRuntimeController()
        assertFailsWith<IllegalStateException> {
            runtime.analyzeImage(prepared, "describe", 32, 0.1f, null)
        }
        // A resident text candidate never serves image work.
        runtime.activateText("qwen3-0.6b-litert-int8", textHandle(FakeText()))
        assertFailsWith<IllegalStateException> {
            runtime.analyzeImage(prepared, "describe", 32, 0.1f, null)
        }
    }

    @Test
    fun activatingASecondCandidateEvictsTheFirst() {
        val runtime = CandidateRuntimeController()
        val first = FakeVision()
        runtime.activateImage(CandidateRuntimeController.VISION_ENTRY, visionHandle(first))
        val second = FakeText()
        runtime.activateText("qwen3-0.6b-litert-int8", textHandle(second))

        assertTrue(first.released, "prior candidate must be released on switch")
        assertEquals("qwen3-0.6b-litert-int8", runtime.residentEntryId())
        assertEquals(CandidateRuntimeController.Role.TEXT, runtime.residentRole())
    }

    @Test
    fun failedInitializationLeavesNoResidentCandidate() {
        val runtime = CandidateRuntimeController()
        val handle = CandidateRuntimeController.VisionHandle(
            initialize = { throw IllegalStateException("init failed") },
            run = { _, _, _, _, _ -> "never" },
            release = {}
        )
        assertFailsWith<IllegalStateException> {
            runtime.activateImage(CandidateRuntimeController.VISION_ENTRY, handle)
        }
        assertNull(runtime.residentEntryId())
        assertFalse(runtime.isActive(CandidateRuntimeController.VISION_ENTRY))
    }

    @Test
    fun cancelForwardsToTheResidentTextHandle() {
        val runtime = CandidateRuntimeController()
        val text = FakeText()
        runtime.activateText("qwen3-0.6b-litert-mixed-int4", textHandle(text))
        runtime.cancel()
        assertTrue(text.cancelled)
    }

    @Test
    fun dedicatedResidentAcquisitionEvictsTheCandidate() {
        var candidateReleased = 0
        val arbiter = GenerativeResidencyArbiter(
            evictImage = {},
            evictText = {},
            evictCandidate = { candidateReleased++ }
        )
        arbiter.acquireImage("smolvlm2-500m")
        arbiter.acquireText("qwen3-0.6b")
        assertEquals(2, candidateReleased, "both dedicated roles evict a candidate first")
    }
}
