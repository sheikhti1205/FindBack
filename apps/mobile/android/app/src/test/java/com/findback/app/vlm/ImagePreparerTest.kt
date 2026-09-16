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
}