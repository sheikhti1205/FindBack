package com.findback.app;

/** Native commit-last policy,independent of Android APIs for host regression tests. */
final class DataEpochReset {
    static final String EPOCH = "product-fit-2026-11-01";
    interface Store {
        String epoch() throws Exception;
        void clearPush() throws Exception;
        void clearMessaging() throws Exception;
        void clearCredentials() throws Exception;
        void clearLegacyPreferences() throws Exception;
        void clearCaches() throws Exception;
        void commitEpoch(String epoch) throws Exception;
    }
    private DataEpochReset() { }

    // Process-wide:plugin recreation/duplicate calls cannot clear new account
    // data after another completed request has allowed the application to start.
    static synchronized boolean prepare(Store store) throws Exception {
        if (EPOCH.equals(store.epoch())) return false;
        store.clearPush();
        store.clearMessaging();
        store.clearCredentials();
        store.clearLegacyPreferences();
        store.clearCaches();
        store.commitEpoch(EPOCH);
        if (!EPOCH.equals(store.epoch())) throw new IllegalStateException("Reset completion unconfirmed");
        return true;
    }
}
