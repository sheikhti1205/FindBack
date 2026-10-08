package com.findback.app.media;

/** Shared pure limits: normal 32/48 MP camera images pass; only pathological headers fail. */
public final class MediaPolicy {
    public static final int MAX_EDGE = 1920;
    public static final int MAX_DERIVATIVE_BYTES = 2_000_000;
    public static final long MAX_STILL_BYTES = 48_000_000L;
    public static final long MAX_CONTAINER_BYTES = 256_000_000L;
    private MediaPolicy() {}
    /** Only our curated errors may be displayed; never surface a decoder/provider exception string. */
    public static class Failure extends IllegalArgumentException {
        public Failure(String message) { super(message); }
    }
    public static int[] target(int width, int height) {
        if (width <= 0 || height <= 0 || width > 32768 || height > 32768 || (long) width * height > 120_000_000L) {
            throw new Failure("This photo has invalid dimensions. Try re-saving it as JPEG.");
        }
        double scale = Math.min(1.0, (double) MAX_EDGE / Math.max(width, height));
        return new int[] {Math.max(1, (int) Math.round(width * scale)), Math.max(1, (int) Math.round(height * scale))};
    }
    public static int sampleSize(int width, int height) {
        target(width, height);
        int sample = 1;
        while ((width + sample - 1) / sample > MAX_EDGE || (height + sample - 1) / sample > MAX_EDGE) sample *= 2;
        return sample;
    }
}
