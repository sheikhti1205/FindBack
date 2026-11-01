package com.findback.app;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.FileVisitResult;
import java.nio.file.attribute.BasicFileAttributes;

/** Fixed app-owned roots only. No content reads and no symlink traversal. */
public final class DataEpochFiles {
    private DataEpochFiles() { }

    public static void clearContents(File directory) throws IOException {
        Path root = directory.toPath();
        if (Files.isSymbolicLink(root)) throw new IOException("Reset root is not a directory");
        if (!Files.exists(root)) return;
        if (!Files.isDirectory(root)) throw new IOException("Reset root is not a directory");
        // walkFileTree does NOT follow links. A child symlink is deleted as a
        // file; its target is never traversed. Keep the fixed directory itself.
        Files.walkFileTree(root, new SimpleFileVisitor<Path>() {
            @Override public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }
            @Override public FileVisitResult postVisitDirectory(Path dir, IOException failure) throws IOException {
                if (failure != null) throw failure;
                if (!dir.equals(root)) Files.delete(dir);
                return FileVisitResult.CONTINUE;
            }
        });
        String[] remaining = directory.list();
        if (remaining == null || remaining.length != 0) throw new IOException("Reset incomplete");
    }
}
