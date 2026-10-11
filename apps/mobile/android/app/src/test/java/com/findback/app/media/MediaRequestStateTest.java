package com.findback.app.media;

import static org.junit.Assert.*;
import org.junit.Test;

public class MediaRequestStateTest {
    @Test public void processDeathPickingRestoresAllSourcesAndTheirRequestId() {
        for (String source : new String[] {"camera", "photos", "files"}) {
            MediaRequestState old = new MediaRequestState(new MediaRequestState.Registry());
            MediaRequestState.Request request = old.begin(source, MediaRequestState.Phase.PICKING);
            MediaRequestState restored = new MediaRequestState(new MediaRequestState.Registry());
            assertNull(restored.restore(old.snapshot()));
            assertTrue(restored.owns(request.id, MediaRequestState.Phase.PICKING));
            assertEquals(source, restored.current().source);
        }
    }
    @Test public void invalidSavedIdNeverRequestsCleanupOutsideOwnedDirectory() {
        MediaRequestState restored = new MediaRequestState(new MediaRequestState.Registry());
        assertNull(restored.restore(new MediaRequestState.Snapshot("../../other", "camera", MediaRequestState.Phase.PROCESSING)));
        assertFalse(restored.isBusy());
    }
    @Test public void unidentifiedCallbackCannotFinishTheCurrentPicker() {
        MediaRequestState state = new MediaRequestState(new MediaRequestState.Registry());
        MediaRequestState.Request request = state.begin("camera", MediaRequestState.Phase.PICKING);
        assertFalse(state.finish(null));
        assertTrue(state.owns(request.id, MediaRequestState.Phase.PICKING));
    }
    @Test public void photosAndFilesPickingRestoreBusyWithoutACaptureFile() {
        for (String source : new String[] {"photos", "files"}) {
            MediaRequestState.Registry registry = new MediaRequestState.Registry();
            MediaRequestState old = new MediaRequestState(registry);
            old.begin(source, MediaRequestState.Phase.PICKING);
            MediaRequestState restored = new MediaRequestState(registry);
            restored.restore(old.snapshot());
            assertTrue(restored.isBusy());
            assertThrows(IllegalStateException.class, () -> restored.begin("camera", MediaRequestState.Phase.PICKING));
        }
    }
    @Test public void restoredPickerTransfersOwnershipSoOldCallbacksCannotDeleteIt() {
        MediaRequestState.Registry registry = new MediaRequestState.Registry();
        MediaRequestState old = new MediaRequestState(registry);
        MediaRequestState.Request request = old.begin("camera", MediaRequestState.Phase.PICKING);
        MediaRequestState restored = new MediaRequestState(registry);
        restored.restore(old.snapshot());
        assertFalse(old.finish(request));
        assertTrue(restored.owns(request.id, MediaRequestState.Phase.PICKING));
        assertTrue(restored.finish(restored.current()));
    }
    @Test public void interruptedProcessingDoesNotWedgeOrDeleteAWorkerOwnedFile() {
        MediaRequestState.Registry registry = new MediaRequestState.Registry();
        MediaRequestState old = new MediaRequestState(registry);
        MediaRequestState.Request running = old.begin("camera", MediaRequestState.Phase.PICKING);
        old.processing(running);
        MediaRequestState restored = new MediaRequestState(registry);
        assertNull(restored.restore(old.snapshot())); // live worker retains cleanup responsibility
        assertFalse(restored.isBusy());
        assertTrue(running.cancelled);
        MediaRequestState.Request next = restored.begin("files", MediaRequestState.Phase.PICKING);
        assertTrue(old.finish(running));
        assertTrue(restored.owns(next.id, MediaRequestState.Phase.PICKING));
    }
    @Test public void processDeathProcessingRequestsOnlyItsOwnAbandonedDirectoryCleanup() {
        MediaRequestState old = new MediaRequestState(new MediaRequestState.Registry());
        MediaRequestState.Request request = old.begin("uri", MediaRequestState.Phase.PROCESSING);
        MediaRequestState restored = new MediaRequestState(new MediaRequestState.Registry());
        assertEquals(request.id, restored.restore(old.snapshot()));
        assertFalse(restored.isBusy());
    }
    @Test public void stalePickingSnapshotCannotRestartAlreadyProcessingMedia() {
        MediaRequestState.Registry registry = new MediaRequestState.Registry();
        MediaRequestState old = new MediaRequestState(registry);
        MediaRequestState.Request request = old.begin("photos", MediaRequestState.Phase.PICKING);
        MediaRequestState.Snapshot before = old.snapshot();
        old.processing(request);
        MediaRequestState restored = new MediaRequestState(registry);
        assertNull(restored.restore(before));
        assertFalse(restored.isBusy());
        assertTrue(request.cancelled);
    }
    @Test public void stalePickingSnapshotCannotRestartAlreadyFinishedMedia() {
        MediaRequestState.Registry registry = new MediaRequestState.Registry();
        MediaRequestState old = new MediaRequestState(registry);
        MediaRequestState.Request request = old.begin("photos", MediaRequestState.Phase.PICKING);
        MediaRequestState.Snapshot before = old.snapshot();
        old.processing(request);
        assertTrue(old.finish(request));
        MediaRequestState restored = new MediaRequestState(registry);
        assertNull(restored.restore(before));
        assertFalse(restored.isBusy());
    }
    /** FBX-001: chooseImages returns URIs then finishes; each importUri is its own PROCESSING request. */
    @Test public void multiPickReleasesThePickerSoEachUriImportCanRunSequentially() {
        MediaRequestState state = new MediaRequestState(new MediaRequestState.Registry());
        MediaRequestState.Request picking = state.begin("photos", MediaRequestState.Phase.PICKING);
        assertTrue(state.owns(picking.id, MediaRequestState.Phase.PICKING));
        assertTrue(state.finish(picking));
        for (int i = 0; i < 5; i++) {
            MediaRequestState.Request importing = state.begin("uri", MediaRequestState.Phase.PROCESSING);
            assertEquals("uri", importing.source);
            assertTrue(state.owns(importing.id, MediaRequestState.Phase.PROCESSING));
            assertTrue(state.finish(importing));
        }
        assertFalse(state.isBusy());
    }
}
