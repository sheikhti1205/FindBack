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
    /**
     * FBX-004/005: 99 MiB is still within the single source cap (it reaches
     * preparation); the probe may consume at most the cap plus one bounded
     * chunk, never more — so the refusal lands before any decode.
     */
    @Test public void sourceAtTheCapIsAcceptedAndOversizedIsRefusedBeforeFullConsumption() throws Exception {
        CountingStream justUnder = new CountingStream(99L * 1024 * 1024);
        assertEquals(99L * 1024 * 1024, MediaStreams.probe(justUnder, 99L * 1024 * 1024).total);
        assertTrue("99 MiB header fast-path must not scan the source", justUnder.consumed <= 65536L);

        CountingStream atCap = new CountingStream(MediaPolicy.MAX_SOURCE_BYTES);
        MediaStreams.Probe probe = MediaStreams.probe(atCap, MediaPolicy.MAX_SOURCE_BYTES);
        assertEquals(MediaPolicy.MAX_SOURCE_BYTES, probe.total);
        assertTrue("probe must not scan past the known length", atCap.consumed <= 65536L);

        CountingStream overCap = new CountingStream(MediaPolicy.MAX_SOURCE_BYTES + 1);
        assertThrows(MediaPolicy.Failure.class, () -> MediaStreams.probe(overCap, MediaPolicy.MAX_SOURCE_BYTES + 1));
        assertTrue("refusal must land before the whole source is read", overCap.consumed <= MediaPolicy.MAX_SOURCE_BYTES + 16_384L);
    }
    @Test public void aKnownLengthOverTheCapFailsWithoutReadingTheSource() {
        CountingStream lazy = new CountingStream(MediaPolicy.MAX_SOURCE_BYTES + 1);
        assertThrows(MediaPolicy.Failure.class, () -> MediaStreams.probe(lazy, MediaPolicy.MAX_SOURCE_BYTES + 1));
        assertEquals("length pre-check must reject with a zero-byte read", 0L, lazy.consumed);
    }
    @Test public void aMissingLengthFallsBackToTheCountingBackstop() throws Exception {
        CountingStream unknown = new CountingStream(1_000);
        MediaStreams.Probe probe = MediaStreams.probe(unknown, -1);
        assertEquals(1_000L, probe.total);
        assertFalse(probe.lengthKnown);
    }
    /** Lazily produced source; never materializes the source-sized payload. */
    private static final class CountingStream extends InputStream {
        private final long size;
        private long remaining;
        long consumed;
        CountingStream(long size) { this.size = size; this.remaining = size; }
        @Override public int read() {
            if (remaining == 0) return -1;
            remaining--; consumed++; return 42;
        }
        @Override public int read(byte[] b, int start, int count) {
            if (remaining == 0) return -1;
            int n = (int) Math.min(remaining, count);
            java.util.Arrays.fill(b, start, start + n, (byte) 42);
            remaining -= n; consumed += n; return n;
        }
    }
}
