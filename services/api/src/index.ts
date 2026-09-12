import http from "node:http";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { getStore } from "./db/index.js";
import { seedDatabase } from "./db/seed.js";
import { attachRealtime } from "./realtime/socket.js";

async function main(): Promise<void> {
  await getStore().init();
  if (process.env.NODE_ENV !== "test" && config.dbProvider !== "supabase") {
    await seedDatabase();
  }
  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server);

  server.listen(config.port, config.host, () => {
    console.log(`FindBack API listening on http://${config.host}:${config.port}`);
    console.log(`  REST+uploads http://localhost:${config.port}   GraphQL /graphql`);
    if (config.devMode) {
      console.log("  dev mode ON: verification codes are echoed in API responses");
    }
  });
}

main().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
