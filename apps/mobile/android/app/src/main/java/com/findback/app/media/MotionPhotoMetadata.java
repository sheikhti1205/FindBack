package com.findback.app.media;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

/** Bounded metadata/range inspection. Modern properties override every deprecated legacy flag. */
public final class MotionPhotoMetadata {
    public interface ReadAt { byte[] read(long offset, int count) throws IOException; }
    public static final class Layout {
        public final long stillEnd;
        public Layout(long stillEnd) { this.stillEnd = stillEnd; }
    }
    private MotionPhotoMetadata() {}
    private static MediaPolicy.Failure invalid() {
        return new MediaPolicy.Failure("Couldn't read the still frame of this motion photo. Try exporting a still JPEG.");
    }
    private static long number(String value, long fallback) {
        if (value == null) return fallback;
        if (!value.matches("\\d+")) throw invalid();
        try { return Long.parseLong(value); } catch (NumberFormatException e) { throw invalid(); }
    }
    public static Layout detect(byte[] prefix, long total, ReadAt read) throws IOException {
        if (prefix.length < 4) return null;
        String brand = MediaContainerProbe.brand(prefix);
        if (brand != null) {
            if (MediaContainerProbe.hasMpvd(total, read)) throw new MediaPolicy.Failure("Couldn't read the still frame of this HEIC/AVIF motion photo. Export a still JPEG and choose it again.");
            return null;
        }
        if ((prefix[0] & 255) != 255 || (prefix[1] & 255) != 216) return null;
        String header = new String(prefix, 0, Math.min(prefix.length, 65536), StandardCharsets.ISO_8859_1);
        XmpMotion metadata;
        try { metadata = XmpMotion.read(header); }
        catch (MediaPolicy.Failure e) {
            if (header.matches("[\\s\\S]*(?:MotionPhoto|MicroVideo)(?:\\s*=|>)[\\s\\S]*")) throw e;
            return null;
        }
        if (metadata.mode == XmpMotion.Mode.NONE || metadata.mode == XmpMotion.Mode.DISABLED) return null;
        if (metadata.mode == XmpMotion.Mode.MODERN) {
            List<XmpMotion.Item> items = metadata.items;
            XmpMotion.Item first = items.get(0);
            if (!"Primary".equals(first.semantic) || !"image/jpeg".equals(first.mime) || number(first.length, 0) != 0) throw invalid();
            long padding = number(first.padding, 0);
            if (padding > 65536) throw invalid();
            long tail = padding;
            int primaryCount = 0, videoCount = 0;
            for (int i = 0; i < items.size(); i++) {
                XmpMotion.Item item = items.get(i);
                if (item.mime == null || item.mime.isEmpty() || item.semantic == null || item.semantic.isEmpty()) throw invalid();
                if ("Primary".equals(item.semantic)) primaryCount++;
                if ("MotionPhoto".equals(item.semantic)) videoCount++;
                if (i > 0) {
                    long length = number(item.length, -1);
                    if (item.padding != null || length < 0 || length >= total || tail > total - length) throw invalid();
                    tail += length;
                }
            }
            XmpMotion.Item video = items.get(items.size() - 1);
            if (primaryCount != 1 || videoCount != 1 || !"MotionPhoto".equals(video.semantic) || (!"video/mp4".equals(video.mime) && !"video/quicktime".equals(video.mime))) throw invalid();
            long stillEnd = total - tail;
            if (stillEnd < 4) throw invalid();
            long cursor = stillEnd + padding, resourceStart = 0, resourceLength = stillEnd;
            for (int i = 1; i < items.size(); i++) {
                long length = number(items.get(i).length, -1);
                if (length > 0) { resourceStart = cursor; resourceLength = length; cursor += length; }
            }
            // A zero-length last item shares the previous physical resource, not the next offset.
            if (resourceStart < stillEnd || resourceLength < 16 || resourceStart + resourceLength != total) throw invalid();
            byte[] eoi = read.read(stillEnd - 2, 2);
            if (eoi.length != 2 || (eoi[0] & 255) != 255 || (eoi[1] & 255) != 217) throw invalid();
            verifyFtyp(read, resourceStart, total, resourceLength);
            return new Layout(stillEnd);
        }
        long length = number(metadata.offset, -1), start = total - length;
        if (length < 16 || start < 4) throw invalid();
        verifyFtyp(read, start, total, length);
        long from = Math.max(2, start - 34);
        byte[] boundary = read.read(from, (int) (start - from));
        for (int i = boundary.length - 2; i >= 0; i--) {
            if ((boundary[i] & 255) == 255 && (boundary[i + 1] & 255) == 217) {
                boolean zero = true;
                for (int j = i + 2; j < boundary.length; j++) zero &= boundary[j] == 0;
                if (zero) return new Layout(from + i + 2);
            }
        }
        throw invalid();
    }
    private static void verifyFtyp(ReadAt read, long start, long total, long videoLength) throws IOException {
        if (start < 4 || start + 12 > total) throw invalid();
        byte[] bytes = read.read(start, 8);
        if (bytes.length != 8) throw invalid();
        long boxSize = ((long) (bytes[0] & 255) << 24) | ((long) (bytes[1] & 255) << 16) | ((bytes[2] & 255) << 8) | (bytes[3] & 255);
        if (boxSize < 8 || boxSize > videoLength || !"ftyp".equals(new String(bytes, 4, 4, StandardCharsets.US_ASCII))) throw invalid();
    }
}
