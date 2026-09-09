import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.findback.app",
  appName: "FindBack",
  webDir: "dist",
  server: {
    // Web assets live inside the APK; the API base is injected via VITE_API_URL.
    androidScheme: "https",
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
