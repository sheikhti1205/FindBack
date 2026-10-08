package com.findback.app.media;

import static org.junit.Assert.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class MediaContainerProbeTest {
    private byte[] fixture(String brand, String box) {
        byte[] bytes = new byte[48];
        ByteBuffer buffer = ByteBuffer.wrap(bytes);
        buffer.putInt(0, 24);
        System.arraycopy("ftypmif1".getBytes(StandardCharsets.US_ASCII), 0, bytes, 4, 8);
        System.arraycopy(brand.getBytes(StandardCharsets.US_ASCII), 0, bytes, 16, 4);
        buffer.putInt(24, 24);
        System.arraycopy(box.getBytes(StandardCharsets.US_ASCII), 0, bytes, 28, 4);
        return bytes;
    }
    @Test public void probesCompatibleBrands() {
        assertEquals("heic", MediaContainerProbe.brand(fixture("heic", "mdat")));
        assertEquals("avif", MediaContainerProbe.brand(fixture("avif", "mdat")));
    }
    @Test public void mpvdRefusesBeforePixelDecodeWithSpecificStillGuidance() {
        for (String brand : new String[] {"heic", "avif"}) {
            byte[] bytes = fixture(brand, "mpvd");
            MediaPolicy.Failure failure = assertThrows(MediaPolicy.Failure.class, () -> MotionPhotoMetadata.detect(bytes, bytes.length, (start, count) -> java.util.Arrays.copyOfRange(bytes, (int) start, (int) start + count)));
            assertTrue(failure.getMessage().contains("still frame"));
        }
    }
    @Test public void neverScansMediaPayloadForAnMpvdString() throws Exception {
        byte[] bytes = fixture("heic", "mdat");
        System.arraycopy("mpvd".getBytes(StandardCharsets.US_ASCII), 0, bytes, 32, 4);
        assertNull(MotionPhotoMetadata.detect(bytes, bytes.length, (start, count) -> java.util.Arrays.copyOfRange(bytes, (int) start, (int) start + count)));
    }
}
