package com.findback.app;

import android.content.res.Configuration;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;
import java.util.Map;

@CapacitorPlugin(name = "FindbackSystemColors")
public class SystemColorsPlugin extends Plugin {
    @PluginMethod public void getColors(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", false);
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                result.put("light", roles(false));
                result.put("dark", roles(true));
                result.put("supported", true);
            } catch (RuntimeException unavailable) {
                // No raw resource data/errors or wallpaper information logged.
                result = new JSObject(); result.put("supported", false);
            }
        }
        call.resolve(result);
    }
    private JSObject roles(boolean dark) {
        JSObject result = new JSObject();
        for (Map.Entry<String, Integer> role : SystemColorsPolicy.read(Build.VERSION.SDK_INT, dark,
                id -> getContext().getResources().getColor(id, getContext().getTheme())).entrySet()) {
            int argb = role.getValue();
            if ((argb >>> 24) != 255) throw new IllegalArgumentException("Non-opaque role");
            result.put(role.getKey(), String.format(Locale.ROOT, "#%06x", argb & 0xffffff));
        }
        return result;
    }
    @Override protected void handleOnResume() { notifyListeners("colorsChanged", new JSObject()); }
    @Override protected void handleOnConfigurationChanged(Configuration configuration) {
        notifyListeners("colorsChanged", new JSObject());
    }
}
