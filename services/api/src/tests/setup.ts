import { beforeAll } from "vitest";
import { resetDb } from "../db/db.js";
import { seedDatabase } from "../db/seed.js";

/**
 * Each test file starts from a clean DB seeded with fictional demo data.
 * Requires vitest fileParallelism:false (shared data-test/findback.db).
 */
beforeAll(async () => {
  resetDb();
  await seedDatabase();
});
