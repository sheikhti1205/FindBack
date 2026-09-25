# FindBack — release keep rules.
#
# Release currently ships with minifyEnabled false, so these rules are dormant
# insurance: if shrinking is ever enabled, the Capacitor bridge entry points
# must survive.

# Capacitor invokes @PluginMethod methods via reflection. The plugin class is
# registered by Class reference (kept automatically) but its methods are not.
-keep public class com.findback.app.vlm.EmbeddingPlugin {
  @com.getcapacitor.PluginMethod <methods>;
}
-keep @interface com.getcapacitor.PluginMethod
-keep @interface com.getcapacitor.Plugin
