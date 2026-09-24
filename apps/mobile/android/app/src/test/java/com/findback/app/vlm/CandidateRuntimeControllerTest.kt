package com.findback.app.vlm

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
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
    fun failedImageInitClosesTheTemporaryHandle() {
        // AI-05: a handle whose initialize() throws must be closed exactly
        // once; the plugin catch cannot reach it once activate throws.
        var closes = 0
        val handle = CandidateRuntimeController.VisionHandle(
            initialize = { throw IllegalStateException("init failed after alloc") },
            run = { _, _, _, _, _ -> "never" },
            release = { closes++ }
        )
        assertFailsWith<IllegalStateException> {
            CandidateRuntimeController().activateImage(CandidateRuntimeController.VISION_ENTRY, handle)
        }
        assertEquals(1, closes, "failed init must not leak the temporary handle")
    }

    @Test
    fun failedTextInitClosesTheTemporaryHandle() {
        var closes = 0
        val handle = CandidateRuntimeController.TextHandle(
            initialize = { throw IllegalStateException("init failed after alloc") },
            run = { _, _, _ -> "never" },
            cancel = {},
            release = { closes++ }
        )
        assertFailsWith<IllegalStateException> {
            CandidateRuntimeController().activateText("qwen3-0.6b-litert-int8", handle)
        }
        assertEquals(1, closes, "failed init must not leak the temporary handle")
    }

    @Test
    fun visionReleaseDuringInflightRunDefersCloseUntilRunFinishes() {
        // AI-01: release() must never close a handle underneath native work.
        val runtime = CandidateRuntimeController()
        val entered = CountDownLatch(1)
        val releaseRun = CountDownLatch(1)
        var closes = 0
        runtime.activateImage(
            CandidateRuntimeController.VISION_ENTRY,
            CandidateRuntimeController.VisionHandle(
                initialize = {},
                run = { _, _, _, _, _ ->
                    entered.countDown()
                    assertTrue(releaseRun.await(10, TimeUnit.SECONDS), "run gate timed out")
                    "vision-output"
                },
                release = { closes++ }
            )
        )
        var result: String? = null
        val worker = thread {
            result = runtime.analyzeImage(prepared, "describe", 32, 0.1f, null)
        }
        assertTrue(entered.await(10, TimeUnit.SECONDS), "run did not start")
        runtime.release()
        // Residency clears synchronously so status is honest, but the close
        // must wait for the in-flight run.
        assertNull(runtime.residentEntryId())
        Thread.sleep(200)
        assertEquals(0, closes, "close must defer while the run is in flight")
        releaseRun.countDown()
        worker.join(10_000)
        assertEquals("vision-output", result)
        assertEquals(1, closes, "exactly one close after the run finishes")
        runtime.release()
        assertEquals(1, closes, "no double close")
    }

    @Test
    fun textReleaseDuringInflightRunDefersCloseUntilRunFinishes() {
        // AI-01 text path: same lease guarantee as vision.
        val runtime = CandidateRuntimeController()
        val entryId = "qwen3-0.6b-litert-int8"
        val entered = CountDownLatch(1)
        val releaseRun = CountDownLatch(1)
        var closes = 0
        runtime.activateText(
            entryId,
            CandidateRuntimeController.TextHandle(
                initialize = {},
                run = { _, _, _ ->
                    entered.countDown()
                    assertTrue(releaseRun.await(10, TimeUnit.SECONDS), "run gate timed out")
                    "text-output"
                },
                cancel = {},
                release = { closes++ }
            )
        )
        var result: String? = null
        val worker = thread {
            result = runtime.generateText(entryId, "hello", 16, 0.1f)
        }
        assertTrue(entered.await(10, TimeUnit.SECONDS), "run did not start")
        runtime.release()
        assertNull(runtime.residentEntryId())
        assertFalse(runtime.isActive(entryId))
        Thread.sleep(200)
        assertEquals(0, closes, "close must defer while the run is in flight")
        releaseRun.countDown()
        worker.join(10_000)
        assertEquals("text-output", result)
        assertEquals(1, closes, "exactly one close after the run finishes")
    }

    @Test
    fun doubleReleaseDuringInflightRunClosesExactlyOnce() {
        val runtime = CandidateRuntimeController()
        val releaseRun = CountDownLatch(1)
        var closes = 0
        runtime.activateText(
            "qwen3-0.6b-litert-mixed-int4",
            CandidateRuntimeController.TextHandle(
                initialize = {},
                run = { _, _, _ ->
                    assertTrue(releaseRun.await(10, TimeUnit.SECONDS), "run gate timed out")
                    "text-output"
                },
                cancel = {},
                release = { closes++ }
            )
        )
        val worker = thread {
            runtime.generateText("qwen3-0.6b-litert-mixed-int4", "hello", 16, 0.1f)
        }
        Thread.sleep(200)
        runtime.release()
        runtime.release()
        releaseRun.countDown()
        worker.join(10_000)
        // The second release sees no resident handle, so only one deferred
        // close exists; the drain must not double-free.
        assertEquals(1, closes)
    }

    @Test
    fun switchDuringInflightRunKeepsNewResidentAndDefersOldClose() {
        // AI-02 overlap guard at controller level: activating B while A's
        // run is in flight records B immediately but A's close still waits.
        val runtime = CandidateRuntimeController()
        val releaseRun = CountDownLatch(1)
        var closesA = 0
        runtime.activateImage(
            CandidateRuntimeController.VISION_ENTRY,
            CandidateRuntimeController.VisionHandle(
                initialize = {},
                run = { _, _, _, _, _ ->
                    assertTrue(releaseRun.await(10, TimeUnit.SECONDS), "run gate timed out")
                    "a-output"
                },
                release = { closesA++ }
            )
        )
        val worker = thread {
            runtime.analyzeImage(prepared, "describe", 32, 0.1f, null)
        }
        Thread.sleep(200)
        val second = FakeText()
        runtime.activateText("qwen3-0.6b-litert-int8", textHandle(second))
        assertEquals("qwen3-0.6b-litert-int8", runtime.residentEntryId())
        assertEquals(0, closesA, "old close must defer while its run is in flight")
        releaseRun.countDown()
        worker.join(10_000)
        assertEquals(1, closesA)
        assertEquals("qwen3-0.6b-litert-int8", runtime.residentEntryId())
    }

    @Test
    fun visionAcquireHoldsLeaseAcrossRelease() {
        // P1: handle capture + lease must be one atomic step. A release()
        // landing after acquire must defer the close, so the run below can
        // never execute on a closed handle.
        val runtime = CandidateRuntimeController()
        var closes = 0
        var ranOnClosed = false
        var closed = false
        runtime.activateImage(
            CandidateRuntimeController.VISION_ENTRY,
            CandidateRuntimeController.VisionHandle(
                initialize = {},
                run = { _, _, _, _, _ ->
                    if (closed) ranOnClosed = true
                    "vision-output"
                },
                release = { closes++; closed = true }
            )
        )
        val handle = runtime.acquireVision()
        runtime.release()
        assertNull(runtime.residentEntryId(), "residency clears synchronously")
        assertEquals(0, closes, "close must defer while the acquired lease is held")
        assertEquals("vision-output", handle.run(prepared, "describe", 32, 0.1f, null))
        assertFalse(ranOnClosed, "run must never execute on a closed handle")
        runtime.endRun()
        assertEquals(1, closes, "exactly one close when the lease finishes")
    }

    @Test
    fun textAcquireRoutesAndHoldsLease() {
        val runtime = CandidateRuntimeController()
        val entryId = "qwen3-0.6b-litert-int8"
        var closes = 0
        runtime.activateText(
            entryId,
            CandidateRuntimeController.TextHandle(
                initialize = {},
                run = { prompt, _, _ -> "echo:$prompt" },
                cancel = {},
                release = { closes++ }
            )
        )
        assertFailsWith<IllegalStateException> {
            runtime.acquireText("qwen3-0.6b-litert-mixed-int4")
        }
        // The failed acquire must not leak a lease: release() below closes
        // synchronously (no deferral) exactly once.
        val handle = runtime.acquireText(entryId)
        runtime.release()
        assertEquals(0, closes, "close must defer while the acquired lease is held")
        assertEquals("echo:hi", handle.run("hi", 16, 0.1f))
        runtime.endRun()
        assertEquals(1, closes)
    }

    @Test
    fun concurrentReleasesDuringLeaseCloseExactlyOnce() {
        val runtime = CandidateRuntimeController()
        var closes = 0
        runtime.activateImage(
            CandidateRuntimeController.VISION_ENTRY,
            CandidateRuntimeController.VisionHandle(
                initialize = {},
                run = { _, _, _, _, _ -> "vision-output" },
                release = { closes++ }
            )
        )
        runtime.acquireVision()
        val errors = java.util.concurrent.ConcurrentLinkedQueue<Throwable>()
        val workers = (0 until 8).map {
            thread {
                try {
                    runtime.release()
                } catch (t: Throwable) {
                    errors.add(t)
                }
            }
        }
        workers.forEach { it.join(10_000) }
        assertTrue(errors.isEmpty(), "release failed: ${errors.firstOrNull()}")
        assertEquals(0, closes, "no close while the lease is held")
        runtime.endRun()
        assertEquals(1, closes, "one deferred close, never a double-free")
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
