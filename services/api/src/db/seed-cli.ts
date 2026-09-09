import { getDb, closeDb } from "./db.js";
import { seedDatabase } from "./seed.js";

// Usage: npm run seed  (seeds only when the users table is empty)
getDb();
seedDatabase()
  .then(() => {
    console.log("Seed complete.");
    closeDb();
  })
  .catch((err) => {
    console.error("Seed failed", err);
    closeDb();
    process.exit(1);
  });
