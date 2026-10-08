package com.findback.app.media;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Arrays;
import java.util.Set;

/** Bounded ftyp compatible-brand probe and top-level box walk, never payload string matching. */
public final class MediaContainerProbe {
    private MediaContainerProbe() {}
    private static long u32(byte[] b, int at) {
        return ((long) (b[at] & 255) << 24) | ((long) (b[at + 1] & 255) << 16) | ((b[at + 2] & 255) << 8) | (b[at + 3] & 255);
    }
    public static String brand(byte[] prefix) {
        if (prefix.length < 12 || !"ftyp".equals(new String(prefix, 4, 4, StandardCharsets.US_ASCII))) return null;
        Set<String> brands = new HashSet<>();
        brands.add(new String(prefix, 8, 4, StandardCharsets.US_ASCII));
        long end = Math.min(Math.min(u32(prefix, 0), prefix.length), 65536);
        for (int at = 16; at + 4 <= end; at += 4) brands.add(new String(prefix, at, 4, StandardCharsets.US_ASCII));
        if (brands.contains("avif") || brands.contains("avis")) return "avif";
        for (String heic : Arrays.asList("heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs")) if (brands.contains(heic)) return "heic";
        return brands.contains("mif1") || brands.contains("msf1") ? "heif" : null;
    }
    public static boolean hasMpvd(long total, MotionPhotoMetadata.ReadAt read) throws IOException {
        long offset = 0;
        for (int boxes = 0; offset + 8 <= total && boxes < 512; boxes++) {
            byte[] header = read.read(offset, 8);
            if (header.length != 8) throw invalid();
            if ("mpvd".equals(new String(header, 4, 4, StandardCharsets.US_ASCII))) return true;
            long size = u32(header, 0), minimum = 8;
            if (size == 0) return false;
            if (size == 1) {
                if (offset + 16 > total) throw invalid();
                byte[] extended = read.read(offset + 8, 8);
                if (extended.length != 8) throw invalid();
                long high = u32(extended, 0), low = u32(extended, 4);
                // Sources already have a 256 MB ceiling. Reject impossible 64-bit lengths.
                if (high != 0) throw invalid();
                size = low; minimum = 16;
            }
            if (size < minimum || size > total - offset) throw invalid();
            offset += size;
        }
        if (offset != total) throw invalid();
        return false;
    }
    private static MediaPolicy.Failure invalid() { return new MediaPolicy.Failure("Couldn't safely read this photo container. Try exporting a still JPEG."); }
}
