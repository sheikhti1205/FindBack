import http from "node:http";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { getDb } from "./db/db.js";
import { seedDatabase } from "./db/seed.js";
import { attachRealtime } from "./realtime/socket.js";

async function main(): Promise<void> {
  getDb();
  if (process.env.NODE_ENV !== "test") {
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
