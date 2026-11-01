package com.findback.app;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;

public class DataEpochFilesTest {
    @Test public void removesStaleSqliteSidecarsAndMediaButKeepsFixedRoot() throws Exception {
        Path root = Files.createTempDirectory("data-epoch-");
        try {
            Files.createDirectories(root.resolve("old-account"));
            Files.write(root.resolve("old-account/history.sqlite3"), new byte[]{1});
            Files.write(root.resolve("old-account/history.sqlite3-wal"), new byte[]{2});
            Files.write(root.resolve("old-account/history.sqlite3-shm"), new byte[]{3});
            DataEpochFiles.clearContents(root.toFile());
            assertTrue(Files.isDirectory(root));
            assertEquals(0, root.toFile().list().length);
            DataEpochFiles.clearContents(root.toFile());
            assertEquals(0, root.toFile().list().length);
        } finally { DataEpochFiles.clearContents(root.toFile()); Files.deleteIfExists(root); }
    }

    @Test public void neverFollowsChildSymlinkIntoUnrelatedData() throws Exception {
        Path root = Files.createTempDirectory("data-epoch-"), outside = Files.createTempDirectory("other-app-");
        try {
            Files.write(outside.resolve("keep"), new byte[]{8});
            Files.createSymbolicLink(root.resolve("foreign"), outside);
            DataEpochFiles.clearContents(root.toFile());
            assertTrue(Files.exists(outside.resolve("keep")));
            assertEquals(0, root.toFile().list().length);
        } finally { DataEpochFiles.clearContents(root.toFile()); Files.delete(root); Files.deleteIfExists(outside.resolve("keep")); Files.delete(outside); }
    }

    @Test public void refusesReplacedRootInsteadOfWalkingOutsideBoundary() throws Exception {
        Path parent = Files.createTempDirectory("data-epoch-"), outside = Files.createTempDirectory("other-app-");
        Path link = parent.resolve("messaging");
        try {
            Files.write(outside.resolve("keep"), new byte[]{8});
            Files.createSymbolicLink(link, outside);
            try { DataEpochFiles.clearContents(link.toFile()); fail("symlink root accepted"); }
            catch (java.io.IOException expected) { }
            assertTrue(Files.exists(outside.resolve("keep")));
        } finally { Files.deleteIfExists(link); Files.delete(parent); Files.deleteIfExists(outside.resolve("keep")); Files.delete(outside); }
    }

    @Test public void absentDirectoryIsAlreadyEmptyButFileIsNotADirectory() throws Exception {
        Path parent = Files.createTempDirectory("data-epoch-");
        try {
            DataEpochFiles.clearContents(parent.resolve("absent").toFile());
            File file = parent.resolve("not-directory").toFile(); Files.write(file.toPath(), new byte[]{4});
            try { DataEpochFiles.clearContents(file); fail("non-directory accepted"); }
            catch (java.io.IOException expected) { }
            assertTrue(file.isFile());
        } finally { DataEpochFiles.clearContents(parent.toFile()); Files.delete(parent); }
    }
}
