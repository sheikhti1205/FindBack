package com.findback.app;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** No paths/credentials cross the bridge. Invoked before any JS application owner. */
@CapacitorPlugin(name = "FindbackDataEpoch")
public final class DataEpochPlugin extends Plugin {
    static final String EPOCH = DataEpochReset.EPOCH;

    @PluginMethod public void prepare(PluginCall call) {
        if (!EPOCH.equals(call.getString("epoch"))) {
            call.reject("Could not prepare app data", "DATA_EPOCH_INVALID");
            return;
        }
        getBridge().execute(() -> {
            try {
                SharedPreferences marker = getContext().getSharedPreferences("findback.data.epoch", Context.MODE_PRIVATE);
                boolean changed = DataEpochReset.prepare(new DataEpochReset.Store() {
                    public String epoch() { return marker.getString("epoch", null); }
                    public void commitEpoch(String value) {
                        if (!marker.edit().putString("epoch", value).commit()) throw new IllegalStateException();
                    }
                });
                JSObject receipt = new JSObject();
                receipt.put("epoch", EPOCH);
                receipt.put("changed", changed);
                call.resolve(receipt);
            } catch (Exception ignored) {
                call.reject("Could not prepare app data", "DATA_EPOCH_FAILED");
            }
        });
    }
}
