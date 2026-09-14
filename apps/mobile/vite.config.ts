import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Supabase Auth/Data/Realtime/Storage/Functions are called directly from the
// app with the publishable key only. The secret key must never reach the mobile
// bundle. No API base URL is needed.
const supabaseUrl = process.env.VITE_SUPABASE_URL ?? "";
const supabasePublishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
  },
  define: {
    __SUPABASE_URL__: JSON.stringify(supabaseUrl),
    __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(supabasePublishableKey),
  },
});
