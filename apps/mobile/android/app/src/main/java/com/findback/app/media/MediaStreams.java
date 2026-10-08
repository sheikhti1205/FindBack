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
        Probe(byte[] prefix, long total) { this.prefix = prefix; this.total = total; }
    }
    public static Probe probe(InputStream input) throws IOException {
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
            if (total > MediaPolicy.MAX_CONTAINER_BYTES) throw new MediaPolicy.Failure("This photo container is too large to prepare safely. Try exporting a still JPEG.");
            int copy = Math.min(n, prefix.length - prefixLength);
            System.arraycopy(chunk, 0, prefix, prefixLength, copy); prefixLength += copy;
        }
        return new Probe(Arrays.copyOf(prefix, prefixLength), total);
    }
    public static void copyStill(InputStream input, OutputStream output, long length) throws IOException {
        if (length <= 0 || length > MediaPolicy.MAX_STILL_BYTES) throw new MediaPolicy.Failure("Couldn't read the still frame.");
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
