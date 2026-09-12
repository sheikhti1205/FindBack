import { closeDb, getAdapter } from "./index.js";
import { seedDatabase } from "./seed.js";

// Usage: npm run seed  (seeds only when the users table is empty)
getAdapter()
  .init()
  .then(() => seedDatabase())
  .then(() => {
    console.log("Seed complete.");
    return closeDb();
  })
  .catch(async (err) => {
    console.error("Seed failed", err);
    await closeDb();
    process.exit(1);
  });
