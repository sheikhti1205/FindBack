import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";

// Supabase Auth/Data/Realtime/Storage/Functions are called directly from the
// app with the publishable key only. The secret key must never reach the mobile
// bundle. No API base URL is needed.
export function resolveSupabaseBuildEnv(
  mode: string,
  envDir = resolve(import.meta.dirname, "../.."),
) {
  const env = loadEnv(mode, envDir, "VITE_");
  return {
    publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "",
    url: env.VITE_SUPABASE_URL ?? "",
  };
}

export default defineConfig(({ mode }) => {
  const { publishableKey, url } = resolveSupabaseBuildEnv(mode);
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      host: true,
    },
    define: {
      __SUPABASE_URL__: JSON.stringify(url),
      __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(publishableKey),
    },
  };
});
