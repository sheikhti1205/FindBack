import { closeDb, getAdapter } from "./index.js";
import { applyMigrations, migrationFiles } from "./migrate.js";

/**
 * Applies pending `supabase/migrations/*.sql` to the configured PostgreSQL /
 * Supabase database. Requires DB_PROVIDER=postgres and DATABASE_URL.
 *
 * Usage: DB_PROVIDER=postgres DATABASE_URL=postgres://... npm run db:migrate
 */
async function main(): Promise<void> {
  const db = getAdapter();
  if (db.dialect !== "postgres") {
    console.error(
      `db:migrate targets PostgreSQL/Supabase but DB_PROVIDER is "${db.dialect}".\n` +
        "Set DB_PROVIDER=postgres and DATABASE_URL (Supabase connection string).",
    );
    process.exit(1);
  }
  await db.init();
  const applied = await applyMigrations(db);
  console.log(
    applied.length
      ? `Applied ${applied.length} migration(s): ${applied.join(", ")}`
      : `No pending migrations (${migrationFiles().length} known).`,
  );
  await closeDb();
}

main().catch(async (err) => {
  console.error("Migration failed", err);
  await closeDb();
  process.exit(1);
});
