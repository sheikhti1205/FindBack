package com.findback.app.vlm

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ImagePreparerTest {
    @Test fun mapsExifOrientationToDegrees() {
        assertEquals(0, ImageOrientation.degreesFor(1))
        assertEquals(90, ImageOrientation.degreesFor(6))
        assertEquals(180, ImageOrientation.degreesFor(3))
        assertEquals(270, ImageOrientation.degreesFor(8))
    }

    @Test fun stripsOnlyTheFileSchemeAndNeverTouchesABarePath() {
        assertEquals("/data/x.jpg", ImagePreparer.absolutePathFor("file:///data/x.jpg"))
        assertEquals("/data/x.jpg", ImagePreparer.absolutePathFor("/data/x.jpg"))
    }

    @Test fun cleanupDeletesOnlyTheExactTemporaryFile() {
        val temp = File.createTempFile("vlm-input", ".jpg")
        val other = File.createTempFile("vlm-keep", ".jpg")
        try {
            ImagePreparer.cleanupTemporary(temp)
            assertFalse(temp.exists())
            assertTrue(other.exists())
        } finally { other.delete() }
    }

    @Test fun sampleSizeLeavesSmallImagesUntouched() {
        assertEquals(1, ImagePreparer.sampleSizeFor(1024, 1024))
        assertEquals(1, ImagePreparer.sampleSizeFor(800, 1024))
    }

    @Test fun sampleSizeCapsLongSideAtMaxDimension() {
        // 50 MP-class camera photo: longest side must decode to <= 1024.
        val sample = ImagePreparer.sampleSizeFor(8192, 1024)
        assertTrue(8192 / sample <= 1024)
    }

    @Test fun sampleSizeIsMinimalPowerOfTwo() {
        // Contract: power of two, longest side decodes within cap (integer
        // division), and halving it would breach the cap.
        val cases = listOf(1025 to 1024, 2048 to 1024, 2049 to 1024, 8192 to 1024, 5000 to 1024)
        for ((maxSide, maxDim) in cases) {
            val sample = ImagePreparer.sampleSizeFor(maxSide, maxDim)
            assertTrue(sample >= 1 && (sample and (sample - 1)) == 0, "power of two, got $sample")
            assertTrue(maxSide / sample <= maxDim)
            if (sample > 1) assertTrue(maxSide / (sample / 2) > maxDim, "not minimal for $maxSide")
        }
    }
}