package com.findback.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class DataEpochResetTest {
    private static final class Store implements DataEpochReset.Store {
        String epoch = "old", fail;
        final List<String> actions = new ArrayList<>();
        public String epoch() { return epoch; }
        private void step(String action) throws Exception {
            actions.add(action);
            if (action.equals(fail)) throw new Exception("synthetic failure");
        }
        public void clearPush() throws Exception { step("push"); }
        public void clearMessaging() throws Exception { step("messaging"); }
        public void clearCredentials() throws Exception { step("credentials"); }
        public void clearLegacyPreferences() throws Exception { step("legacy"); }
        public void clearCaches() throws Exception { step("cache"); }
        public void commitEpoch(String value) throws Exception { step("commit"); epoch = value; }
    }

    @Test public void oldMarkerOnlyUpdatesMetadataWithoutClearingNativeStores() throws Exception {
        Store s = new Store();
        assertTrue(DataEpochReset.prepare(s));
        assertEquals(Arrays.asList("commit"), s.actions);
        assertEquals("product-fit-2026-11-01", s.epoch);
    }
    @Test public void sameEpochPreservesNewUserState() throws Exception {
        Store s = new Store(); s.epoch = "product-fit-2026-11-01";
        assertFalse(DataEpochReset.prepare(s));
        assertTrue(s.actions.isEmpty());
    }
    @Test public void missingMarkerDoesNotAuthorizeDeletingNativeState() throws Exception {
        Store s = new Store(); s.epoch = null;
        assertTrue(DataEpochReset.prepare(s));
        assertEquals(Arrays.asList("commit"), s.actions);
    }
    @Test public void deniedMarkerWriteDoesNotClearNativeStateAndRetriesMetadataOnly() throws Exception {
        Store s = new Store(); s.fail = "commit";
        try { DataEpochReset.prepare(s); fail("failure ignored"); }
        catch (Exception expected) { }
        assertEquals("old", s.epoch);
        assertEquals(Arrays.asList("commit"), s.actions);
        s.fail = null; s.actions.clear();
        assertTrue(DataEpochReset.prepare(s));
        assertEquals("product-fit-2026-11-01", s.epoch);
        assertEquals(Arrays.asList("commit"), s.actions);
    }
}
