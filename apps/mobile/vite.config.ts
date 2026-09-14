import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Where the app reaches the FindBack API.
// - Vite dev: default to the local API on :4000 (CORS is open in dev).
// - Capacitor/Android: set VITE_API_URL to the dev machine's LAN address.
const apiUrl = process.env.VITE_API_URL ?? "http://localhost:4000";

// Supabase Auth is called directly from the app with the publishable key only.
// The secret key must never reach the mobile bundle.
const supabaseUrl = process.env.VITE_SUPABASE_URL ?? "";
const supabasePublishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
  },
  define: {
    __API_URL__: JSON.stringify(apiUrl),
    __SUPABASE_URL__: JSON.stringify(supabaseUrl),
    __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(supabasePublishableKey),
  },
});
