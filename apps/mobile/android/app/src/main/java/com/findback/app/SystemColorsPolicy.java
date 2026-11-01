package com.findback.app;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.IntUnaryOperator;

/** Read only principal roles. No app palette, wallpaper access or semantic colors. */
public final class SystemColorsPolicy {
    private SystemColorsPolicy() {}
    public static Map<String, Integer> read(int sdk, boolean dark, IntUnaryOperator colors) {
        Map<String, Integer> result = new LinkedHashMap<>();
        if (sdk < 31) return result;
        int primary, onPrimary, container, onContainer;
        if (sdk >= 34) {
            primary = dark ? android.R.color.system_primary_dark : android.R.color.system_primary_light;
            onPrimary = dark ? android.R.color.system_on_primary_dark : android.R.color.system_on_primary_light;
            container = dark ? android.R.color.system_primary_container_dark : android.R.color.system_primary_container_light;
            onContainer = dark ? android.R.color.system_on_primary_container_dark : android.R.color.system_on_primary_container_light;
        } else {
            // AndroidX Material3 dynamic scheme tones: light40/100/90/10,
            // dark80/20/30/90. Android accent1 resource suffix is 1000-tone*10.
            primary = dark ? android.R.color.system_accent1_200 : android.R.color.system_accent1_600;
            onPrimary = dark ? android.R.color.system_accent1_800 : android.R.color.system_accent1_0;
            container = dark ? android.R.color.system_accent1_700 : android.R.color.system_accent1_100;
            onContainer = dark ? android.R.color.system_accent1_100 : android.R.color.system_accent1_900;
        }
        result.put("primary", colors.applyAsInt(primary));
        result.put("onPrimary", colors.applyAsInt(onPrimary));
        result.put("primaryContainer", colors.applyAsInt(container));
        result.put("onPrimaryContainer", colors.applyAsInt(onContainer));
        result.put("link", result.get(dark ? "primary" : "onPrimaryContainer"));
        return result;
    }
}
