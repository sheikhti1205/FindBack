import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Where the app reaches the FindBack API.
// - Vite dev: default to the local API on :4000 (CORS is open in dev).
// - Capacitor/Android: set VITE_API_URL to the dev machine's LAN address.
const apiUrl = process.env.VITE_API_URL ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: true,
  },
  define: {
    __API_URL__: JSON.stringify(apiUrl),
  },
});
