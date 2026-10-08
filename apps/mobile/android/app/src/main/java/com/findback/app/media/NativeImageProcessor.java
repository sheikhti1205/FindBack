package com.findback.app.media;

import android.content.ContentResolver;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageDecoder;
import android.graphics.Matrix;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import androidx.exifinterface.media.ExifInterface;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Native URI -> bounded first-frame pixels -> metadata-free derivative. No original bytes enter JS. */
final class NativeImageProcessor {
    private final ContentResolver resolver;
    private final File cache;
    NativeImageProcessor(ContentResolver resolver, File cache) { this.resolver = resolver; this.cache = cache; }

    JSObject prepare(Uri uri, boolean highQuality) throws IOException {
        if (!"content".equals(uri.getScheme())) throw new MediaPolicy.Failure("Please choose a photo through the device picker.");
        // A streaming probe handles providers with unknown/lying lengths. At most 64 KiB retained.
        MediaStreams.Probe probe;
        try (InputStream input = open(uri)) {
            probe = MediaStreams.probe(input);
        }
        byte[] prefix = probe.prefix;
        long total = probe.total;
        if (total == 0) throw new MediaPolicy.Failure("This photo is empty. Choose another photo.");
        String kind = sniff(prefix);
        if (kind == null) throw new MediaPolicy.Failure("This photo format isn't supported on this device. Try a JPEG or PNG.");
        MotionPhotoMetadata.Layout motion = MotionPhotoMetadata.detect(prefix, total, (offset, count) -> readAt(uri, offset, count));
        long stillLength = motion == null ? total : motion.stillEnd;
        if (stillLength > MediaPolicy.MAX_STILL_BYTES) throw new MediaPolicy.Failure("This photo is too large to prepare safely. Try exporting a smaller JPEG.");
        File stillFile = null;
        Bitmap bitmap = null;
        final boolean[] animated = { false };
        ExifInterface exif = null;
        if ("jpeg".equals(kind) || "heic".equals(kind) || "heif".equals(kind)) {
            try (InputStream input = open(uri)) { exif = new ExifInterface(input); } catch (IOException ignored) { /* Decoder still validates the pixels. */ }
        }
        int orientation = exif == null ? 1 : exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, 1);
        if (orientation < 1 || orientation > 8) orientation = 1;
        try {
            if (motion != null) {
                if (cache.getUsableSpace() < stillLength + 8_000_000L) throw new MediaPolicy.Failure("Not enough device space to prepare this photo.");
                stillFile = File.createTempFile("findback-media-still-", ".jpg", cache);
                try (InputStream input = open(uri); FileOutputStream output = new FileOutputStream(stillFile)) {
                    MediaStreams.copyStill(input, output, stillLength);
                }
            }
            if (Build.VERSION.SDK_INT >= 28) {
                // Ordinary images decode directly from a granted content URI, never a JS buffer.
                ImageDecoder.Source source = stillFile == null ? ImageDecoder.createSource(resolver, uri) : ImageDecoder.createSource(stillFile);
                bitmap = ImageDecoder.decodeBitmap(source, (decoder, info, unused) -> {
                    int[] target = MediaPolicy.target(info.getSize().getWidth(), info.getSize().getHeight());
                    decoder.setTargetSize(target[0], target[1]);
                    decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                    decoder.setOnPartialImageListener(error -> false);
                    animated[0] = info.isAnimated();
                });
            } else {
                if ("heic".equals(kind) || "heif".equals(kind) || "avif".equals(kind)) throw new MediaPolicy.Failure("HEIC/HEIF/AVIF decoding isn't available on this Android version. Try a JPEG.");
                BitmapFactory.Options bounds = new BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                try (InputStream input = openStill(uri, stillFile)) { BitmapFactory.decodeStream(input, null, bounds); }
                BitmapFactory.Options options = new BitmapFactory.Options();
                options.inSampleSize = MediaPolicy.sampleSize(bounds.outWidth, bounds.outHeight);
                options.inPreferredConfig = Bitmap.Config.ARGB_8888;
                try (InputStream input = openStill(uri, stillFile)) { bitmap = BitmapFactory.decodeStream(input, null, options); }
                if (bitmap == null) throw new MediaPolicy.Failure("Couldn't read this photo. Try re-saving it as JPEG.");
                if (exif != null && orientation != 1) {
                    Matrix matrix = new Matrix();
                    if (exif.isFlipped()) matrix.setScale(-1, 1);
                    matrix.postRotate(exif.getRotationDegrees());
                    Bitmap oriented = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
                    if (oriented != bitmap) { bitmap.recycle(); bitmap = oriented; }
                }
                // Pre-28 GIF decode already yields the first frame. Conservatively disclose it.
                animated[0] = "gif".equals(kind) || isAnimatedHeader(prefix, kind);
            }
            if (bitmap == null) throw new MediaPolicy.Failure("Couldn't read this photo.");
            MediaPolicy.target(bitmap.getWidth(), bitmap.getHeight());
            if (bitmap.getWidth() > MediaPolicy.MAX_EDGE || bitmap.getHeight() > MediaPolicy.MAX_EDGE) throw new MediaPolicy.Failure("Couldn't safely resize this photo.");
            boolean png = bitmap.hasAlpha();
            int[] qualities = png ? new int[] {100} : highQuality ? new int[] {92, 82, 70, 55, 40} : new int[] {82, 70, 55, 40};
            byte[] derivative = null;
            int quality = 100;
            for (int candidate : qualities) {
                LimitedBytes encoded = new LimitedBytes();
                try {
                    boolean ok = bitmap.compress(png ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG, candidate, encoded);
                    if (ok && !encoded.exceeded && encoded.size() > 0) { derivative = encoded.toByteArray(); quality = candidate; break; }
                } catch (DerivativeLimitException ignored) { /* Try the next quality with the same bounded bitmap. */ }
            }
            if (derivative == null) throw new MediaPolicy.Failure("Couldn't shrink this photo safely. Try another photo or a smaller JPEG.");
            JSObject result = new JSObject();
            result.put("derivativeBase64", Base64.encodeToString(derivative, Base64.NO_WRAP));
            result.put("width", bitmap.getWidth()); result.put("height", bitmap.getHeight());
            result.put("mimeType", png ? "image/png" : "image/jpeg");
            result.put("sourceKind", animated[0] && ("gif".equals(kind) || "webp".equals(kind) || "png".equals(kind)) ? kind + "-animated" : kind);
            result.put("originalByteLength", stillLength);
            result.put("motionStillUsed", motion != null);
            result.put("videoBytesStripped", total - stillLength);
            result.put("sampledStill", animated[0]);
            result.put("locationMetadataStripped", true);
            result.put("orientation", orientation);
            result.put("quality", png ? org.json.JSONObject.NULL : (double) quality / 100);
            return result;
        } finally {
            if (bitmap != null) bitmap.recycle();
            if (stillFile != null) stillFile.delete();
        }
    }
    private InputStream open(Uri uri) throws IOException {
        InputStream input = resolver.openInputStream(uri);
        if (input == null) throw new IOException("This photo isn't available. Choose it again.");
        return input;
    }
    private InputStream openStill(Uri uri, File still) throws IOException {
        return still == null ? open(uri) : new java.io.FileInputStream(still);
    }
    private byte[] readAt(Uri uri, long start, int count) throws IOException {
        try (InputStream input = open(uri)) {
            long remaining = start;
            while (remaining > 0) {
                long skipped = input.skip(remaining);
                if (skipped == 0) { if (input.read() == -1) throw new IOException("Couldn't read the still frame."); skipped = 1; }
                remaining -= skipped;
            }
            byte[] bytes = new byte[count];
            int at = 0;
            while (at < count) {
                int n = input.read(bytes, at, count - at);
                if (n < 0) throw new IOException("Couldn't read the still frame.");
                at += n;
            }
            return bytes;
        }
    }
    private static String sniff(byte[] p) {
        if (p.length < 12) return null;
        if ((p[0] & 255) == 255 && (p[1] & 255) == 216 && (p[2] & 255) == 255) return "jpeg";
        if ((p[0] & 255) == 137 && "PNG".equals(new String(p, 1, 3, StandardCharsets.US_ASCII))) return "png";
        String magic = new String(p, 0, 6, StandardCharsets.US_ASCII);
        if ("GIF87a".equals(magic) || "GIF89a".equals(magic)) return "gif";
        if ("RIFF".equals(new String(p, 0, 4, StandardCharsets.US_ASCII)) && "WEBP".equals(new String(p, 8, 4, StandardCharsets.US_ASCII))) return "webp";
        if (p[0] == 'B' && p[1] == 'M') return "bmp";
        return MediaContainerProbe.brand(p);
    }
    private static boolean isAnimatedHeader(byte[] prefix, String kind) {
        String header = new String(prefix, StandardCharsets.ISO_8859_1);
        return "webp".equals(kind) && header.contains("ANIM") || "png".equals(kind) && header.contains("acTL");
    }
    private static final class DerivativeLimitException extends RuntimeException {}
    private static final class LimitedBytes extends ByteArrayOutputStream {
        boolean exceeded;
        LimitedBytes() { super(65536); }
        @Override public synchronized void write(byte[] bytes, int start, int length) {
            if (length > MediaPolicy.MAX_DERIVATIVE_BYTES - count) { exceeded = true; throw new DerivativeLimitException(); }
            super.write(bytes, start, length);
        }
        @Override public synchronized void write(int value) {
            if (count >= MediaPolicy.MAX_DERIVATIVE_BYTES) { exceeded = true; throw new DerivativeLimitException(); }
            super.write(value);
        }
    }
}
