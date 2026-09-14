import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.findback.app",
  appName: "FindBack",
  webDir: "dist",
  server: {
    // Web assets live inside the APK; the app talks only to hosted Supabase (HTTPS).
    androidScheme: "https",
  },
};

export default config;
