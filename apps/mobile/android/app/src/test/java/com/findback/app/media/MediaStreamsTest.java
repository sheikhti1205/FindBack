package com.findback.app.media;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import org.junit.Test;

public class MediaStreamsTest {
    @Test public void nativeProbeRetainsOnlyTheHeaderEvenForLargeSources() throws Exception {
        InputStream source = new InputStream() {
            long remaining = 20_000_000;
            public int read() { if (remaining == 0) return -1; remaining--; return 42; }
            public int read(byte[] b, int start, int count) {
                if (remaining == 0) return -1;
                int n = (int) Math.min(remaining, count);
                java.util.Arrays.fill(b, start, start + n, (byte) 42); remaining -= n; return n;
            }
        };
        MediaStreams.Probe probe = MediaStreams.probe(source);
        assertEquals(20_000_000, probe.total);
        assertEquals(65536, probe.prefix.length);
        assertEquals(42, probe.prefix[65535]);
    }
    @Test public void maliciousUnknownLengthSourceIsStoppedWithoutAllocatingTheSource() {
        InputStream endless = new InputStream() {
            public int read() { return 42; }
            public int read(byte[] b, int start, int count) { return count; }
        };
        assertThrows(MediaPolicy.Failure.class, () -> MediaStreams.probe(endless));
    }
    @Test public void motionCopyExcludesAllVideoBytes() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ByteArrayInputStream input = new ByteArrayInputStream(new byte[] {1, 2, 3, 4, 99, 98});
        MediaStreams.copyStill(input, output, 4);
        assertArrayEquals(new byte[] {1, 2, 3, 4}, output.toByteArray());
        assertEquals(99, input.read());
    }
    @Test public void truncatedStillCopyFailsClosed() {
        assertThrows(MediaPolicy.Failure.class, () -> MediaStreams.copyStill(new ByteArrayInputStream(new byte[] {1, 2}), new ByteArrayOutputStream(), 4));
    }
}
