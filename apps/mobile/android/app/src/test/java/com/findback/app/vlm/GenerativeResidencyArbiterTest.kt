package com.findback.app.vlm

import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GenerativeResidencyArbiterTest {

    companion object {
        private const val IMAGE_ID = "smolvlm2-500m"
        private const val TEXT_ID = "qwen3-0.6b"
    }

    private class FakeSlots {
        @Volatile var imageResident = false
        @Volatile var textResident = false
        @Volatile var textNativeRunning = false
        @Volatile var textDeferredClose = false
        var imageEvictions = 0
        var textEvictions = 0

        fun arbiter() = GenerativeResidencyArbiter(
            evictImage = {
                imageEvictions++
                imageResident = false
            },
            evictText = {
                textEvictions++
                textResident = false
            }
        )

        fun assertSingle() {
            assertFalse(imageResident && textResident, "dual residency observed")
        }
    }

    @Test fun emptySnapshotExposesNullDiagnostics() {
        val snapshot = GenerativeResidencyArbiter().snapshot()
        assertNull(snapshot.residentEntryId)
        assertNull(snapshot.residentRole)
    }

    @Test fun imageThenTextAttemptCannotHoldBoth() {
        val slots = FakeSlots()
        val arbiter = slots.arbiter()
        arbiter.acquireImage(IMAGE_ID)
        slots.imageResident = true
        arbiter.acquireText(TEXT_ID)
        slots.textResident = true
        slots.assertSingle()
        assertFalse(slots.imageResident)
        assertTrue(slots.textResident)
        assertEquals(1, slots.imageEvictions)
        assertEquals(TEXT_ID, arbiter.snapshot().residentEntryId)
        assertEquals(GenerativeResidencyArbiter.ResidencyRole.TEXT, arbiter.snapshot().residentRole)
    }

    @Test fun textThenImageAttemptCannotHoldBoth() {
        val slots = FakeSlots()
        val arbiter = slots.arbiter()
        arbiter.acquireText(TEXT_ID)
        slots.textResident = true
        arbiter.acquireImage(IMAGE_ID)
        slots.imageResident = true
        slots.assertSingle()
        assertFalse(slots.textResident)
        assertTrue(slots.imageResident)
        assertEquals(1, slots.textEvictions)
        assertEquals(IMAGE_ID, arbiter.snapshot().residentEntryId)
        assertEquals(GenerativeResidencyArbiter.ResidencyRole.IMAGE, arbiter.snapshot().residentRole)
    }

    @Test fun simultaneousAcquiresResolveToSingleResident() {
        val slots = FakeSlots()
        val arbiter = slots.arbiter()
        val errors = ConcurrentLinkedQueue<Throwable>()
        val gate = CountDownLatch(1)
        val imageWorker = thread {
            try {
                assertTrue(gate.await(10, TimeUnit.SECONDS), "start gate timed out")
                arbiter.acquireImage(IMAGE_ID)
            } catch (t: Throwable) {
                errors.add(t)
            }
        }
        val textWorker = thread {
            try {
                assertTrue(gate.await(10, TimeUnit.SECONDS), "start gate timed out")
                arbiter.acquireText(TEXT_ID)
            } catch (t: Throwable) {
                errors.add(t)
            }
        }
        gate.countDown()
        imageWorker.join(10_000)
        textWorker.join(10_000)
        assertTrue(errors.isEmpty(), "worker failed: ${errors.firstOrNull()}")
        val snapshot = arbiter.snapshot()
        assertTrue(snapshot.residentRole != null && snapshot.residentEntryId != null)
        assertEquals(1, slots.imageEvictions + slots.textEvictions)
    }

    @Test fun serializedAcquiresNeverDualResident() {
        val slots = FakeSlots()
        val arbiter = slots.arbiter()
        val mutex = Any()
        val violations = AtomicInteger(0)
        val errors = ConcurrentLinkedQueue<Throwable>()
        val workers = (0 until 4).map { index ->
            thread {
                try {
                    repeat(200) { iteration ->
                        synchronized(mutex) {
                            if ((iteration + index) % 2 == 0) {
                                arbiter.acquireImage(IMAGE_ID)
                                slots.imageResident = true
                            } else {
                                arbiter.acquireText(TEXT_ID)
                                slots.textResident = true
                            }
                            if (slots.imageResident && slots.textResident) {
                                violations.incrementAndGet()
                            }
                        }
                    }
                } catch (t: Throwable) {
                    errors.add(t)
                }
            }
        }
        workers.forEach { it.join(30_000) }
        assertTrue(errors.isEmpty(), "worker failed: ${errors.firstOrNull()}")
        assertEquals(0, violations.get())
        slots.assertSingle()
        val snapshot = arbiter.snapshot()
        assertTrue(snapshot.residentRole != null && snapshot.residentEntryId != null)
    }

    @Test fun evictionWhilePeerRunningDefersInsteadOfYanking() {
        var cancelCount = 0
        val slots = FakeSlots()
        val arbiter = GenerativeResidencyArbiter(
            evictImage = { slots.imageResident = false },
            evictText = {
                slots.textEvictions++
                if (slots.textNativeRunning) {
                    cancelCount++
                    slots.textDeferredClose = true
                } else {
                    slots.textResident = false
                }
            }
        )
        arbiter.acquireText(TEXT_ID)
        slots.textResident = true
        slots.textNativeRunning = true
        arbiter.acquireImage(IMAGE_ID)
        assertEquals(1, slots.textEvictions)
        assertEquals(1, cancelCount)
        assertTrue(slots.textDeferredClose)
        assertTrue(slots.textResident, "peer close must defer while native code runs")
        assertEquals(
            GenerativeResidencyArbiter.ResidencyRole.IMAGE,
            arbiter.snapshot().residentRole
        )
        slots.textNativeRunning = false
        if (slots.textDeferredClose) {
            slots.textDeferredClose = false
            slots.textResident = false
        }
        slots.imageResident = true
        slots.assertSingle()
    }

    @Test fun sameRoleReacquireKeepsResidentWithoutEvicting() {
        val slots = FakeSlots()
        val arbiter = slots.arbiter()
        arbiter.acquireImage(IMAGE_ID)
        slots.imageResident = true
        val snapshot = arbiter.acquireImage(IMAGE_ID)
        assertEquals(IMAGE_ID, snapshot.residentEntryId)
        assertEquals(GenerativeResidencyArbiter.ResidencyRole.IMAGE, snapshot.residentRole)
        assertEquals(0, slots.textEvictions)
        assertTrue(slots.imageResident)
    }

    @Test fun releaseClearsOnlyMatchingEntry() {
        val arbiter = GenerativeResidencyArbiter()
        arbiter.acquireImage(IMAGE_ID)
        arbiter.release(GenerativeResidencyArbiter.ResidencyRole.TEXT)
        assertEquals(IMAGE_ID, arbiter.snapshot().residentEntryId)
        arbiter.release(GenerativeResidencyArbiter.ResidencyRole.IMAGE, "other-entry")
        assertEquals(IMAGE_ID, arbiter.snapshot().residentEntryId)
        arbiter.release(GenerativeResidencyArbiter.ResidencyRole.IMAGE, IMAGE_ID)
        assertNull(arbiter.snapshot().residentEntryId)
        assertNull(arbiter.snapshot().residentRole)
        arbiter.acquireText(TEXT_ID)
        arbiter.releaseAll()
        assertNull(arbiter.snapshot().residentEntryId)
        assertNull(arbiter.snapshot().residentRole)
    }
}
