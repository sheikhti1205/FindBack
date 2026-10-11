package com.findback.app.media;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;

/** Source-size counting and still extraction are streaming operations, not source-sized allocations. */
public final class MediaStreams {
    private MediaStreams() {}
    public static final class Probe {
        public final byte[] prefix;
        public final long total;
        /** True when total came from a provider length hint; false when counted. */
        public final boolean lengthKnown;
        Probe(byte[] prefix, long total, boolean lengthKnown) {
            this.prefix = prefix; this.total = total; this.lengthKnown = lengthKnown;
        }
    }
    /** Counting fallback: streams the source once to learn its true length (FBX-005 backstop). */
    public static Probe probe(InputStream input) throws IOException {
        return probe(input, -1);
    }
    /**
     * FBX-004/005: one bounded probe under the single source cap.
     *
     * When the provider reports a usable length the header is read and the
     * scan STOPS — a 99 MiB source never reaches the decoder as a source-sized
     * allocation, and a 100 MiB + 1 source is refused with zero further reads.
     * When the length is unknown (or lies), the counting backstop runs: it
     * streams once, retaining only the 64 KiB prefix, and refuses as soon as
     * the cap is crossed.
     */
    public static Probe probe(InputStream input, long knownLength) throws IOException {
        if (knownLength >= 0) {
            if (knownLength > MediaPolicy.MAX_SOURCE_BYTES) throw new MediaPolicy.Failure(MediaPolicy.sourceLimitMessage());
            return new Probe(readPrefix(input, knownLength), knownLength, true);
        }
        byte[] prefix = new byte[65536];
        int prefixLength = 0;
        long total = 0;
        byte[] chunk = new byte[16384];
        int n;
        while ((n = input.read(chunk)) != -1) {
            if (n == 0) {
                int value = input.read();
                if (value < 0) break;
                chunk[0] = (byte) value; n = 1;
            }
            total += n;
            if (total > MediaPolicy.MAX_SOURCE_BYTES) throw new MediaPolicy.Failure(MediaPolicy.sourceLimitMessage());
            int copy = Math.min(n, prefix.length - prefixLength);
            System.arraycopy(chunk, 0, prefix, prefixLength, copy); prefixLength += copy;
        }
        return new Probe(Arrays.copyOf(prefix, prefixLength), total, false);
    }
    /** Header-only read for a known length; never scans the rest of the source. */
    private static byte[] readPrefix(InputStream input, long total) throws IOException {
        int wanted = (int) Math.min(65536L, Math.max(0L, total));
        byte[] prefix = new byte[wanted];
        int at = 0;
        while (at < wanted) {
            int n = input.read(prefix, at, wanted - at);
            if (n < 0) break;
            at += n;
        }
        return Arrays.copyOf(prefix, at);
    }
    public static void copyStill(InputStream input, OutputStream output, long length) throws IOException {
        if (length <= 0 || length > MediaPolicy.MAX_SOURCE_BYTES) throw new MediaPolicy.Failure("Couldn't read the still frame.");
        byte[] chunk = new byte[16384];
        long remaining = length;
        while (remaining > 0) {
            int n = input.read(chunk, 0, (int) Math.min(chunk.length, remaining));
            if (n < 0) throw new MediaPolicy.Failure("Couldn't read the still frame.");
            if (n == 0) {
                int value = input.read();
                if (value < 0) throw new MediaPolicy.Failure("Couldn't read the still frame.");
                chunk[0] = (byte) value; n = 1;
            }
            output.write(chunk, 0, n); remaining -= n;
        }
    }
}
