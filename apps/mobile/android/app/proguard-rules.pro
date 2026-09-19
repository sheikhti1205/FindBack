# FindBack — release keep rules (audit WP12 #31).
#
# Release currently ships with minifyEnabled false, so these rules are dormant
# insurance: if shrinking is ever enabled, the Capacitor bridge entry points,
# the Gson-persisted records, and the manifest-referenced service must survive.
# Verified by assembling assembleRelease with minifyEnabled=true and confirming
# the @PluginMethod entry points are present in the DEX.

# Capacitor invokes @PluginMethod methods via reflection. The plugin class is
# registered by Class reference (kept automatically) but its methods are not.
-keep public class com.findback.app.vlm.LocalVlmPlugin {
  @com.getcapacitor.PluginMethod <methods>;
}
-keep @interface com.getcapacitor.PluginMethod
-keep @interface com.getcapacitor.Plugin

# Gson persists these records via reflection; renaming a field corrupts state.
-keep class com.findback.app.vlm.ModelStateRecord { *; }
-keepclassmembers class com.findback.app.vlm.ModelStateRecord { *; }
-keep class com.findback.app.vlm.InstalledFileRecord { *; }
-keepclassmembers class com.findback.app.vlm.InstalledFileRecord { *; }
-keepclassmembers enum com.findback.app.vlm.VlmModelId { *; }
-keepclassmembers enum com.findback.app.vlm.VlmState { *; }

# Manifest-referenced scheduler entry point (R8 keeps these automatically, but
# pin it so a manifest refactor cannot silently drop the service).
-keep public class com.findback.app.vlm.ModelDownloadJobService { *; }
