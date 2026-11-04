package com.findback.app;

/** Non-destructive compatibility metadata policy,independent of Android APIs. */
final class DataEpochReset {
    static final String EPOCH = "product-fit-2026-11-01";
    interface Store {
        String epoch() throws Exception;
        void commitEpoch(String epoch) throws Exception;
    }
    private DataEpochReset() { }

    // Process-wide metadata serialization. Missing markers are never consent
    // to reset account data; each store owns its supported schema migrations.
    static synchronized boolean prepare(Store store) throws Exception {
        if (EPOCH.equals(store.epoch())) return false;
        store.commitEpoch(EPOCH);
        if (!EPOCH.equals(store.epoch())) throw new IllegalStateException("App preparation unconfirmed");
        return true;
    }
}
