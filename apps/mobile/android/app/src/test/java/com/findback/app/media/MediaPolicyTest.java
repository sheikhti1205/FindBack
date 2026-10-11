package com.findback.app.media;

import static org.junit.Assert.*;
import org.junit.Test;

public class MediaPolicyTest {
    @Test public void normalPhoneDimensionsAreBoundedBeforeDecode() {
        assertArrayEquals(new int[] {1442, 1920}, MediaPolicy.target(4928, 6560));
        assertArrayEquals(new int[] {1920, 1440}, MediaPolicy.target(8000, 6000));
        assertArrayEquals(new int[] {40, 30}, MediaPolicy.target(40, 30));
    }
    @Test public void pathologicalAndOverflowDimensionsAreRefused() {
        for (int[] size : new int[][] {{0, 20}, {20000, 20000}, {Integer.MAX_VALUE, 2}, {40000, 1}}) {
            assertThrows(IllegalArgumentException.class, () -> MediaPolicy.target(size[0], size[1]));
        }
    }
    @Test public void legacyBitmapFactorySampleBoundsTheDecodeNotJustTheCanvas() {
        assertEquals(4, MediaPolicy.sampleSize(4928, 6560));
        assertEquals(8, MediaPolicy.sampleSize(8000, 6000));
        assertEquals(1, MediaPolicy.sampleSize(32, 64));
    }
    /**
     * FBX-004: the native source cap is the SAME 100 MiB semantic bound the JS
     * intake path enforces (services/media/mediaPolicy.ts SOURCE_MAX_BYTES),
     * with the same user-facing copy. Derivative caps are separate.
     */
    @Test public void sourceCapMatchesTheJsIntakePath() {
        assertEquals(100L * 1024 * 1024, MediaPolicy.MAX_SOURCE_BYTES);
        assertEquals("That photo is over the 100 MB source limit and can't be prepared on this device. Choose a smaller image.", MediaPolicy.sourceLimitMessage());
        assertTrue(MediaPolicy.MAX_DERIVATIVE_BYTES < MediaPolicy.MAX_SOURCE_BYTES);
    }
}
