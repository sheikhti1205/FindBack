import { describe, expect, it } from "vitest";
import {
  PostgresAdapter,
  toPgPlaceholders,
  type PgQueryResult,
  type PgQueryable,
} from "../db/postgresAdapter.js";
import type { Row } from "../db/types.js";

/** In-memory fake; records every query so we can assert SQL + binding shape. */
class FakePg implements PgQueryable {
  calls: { text: string; values?: unknown[] }[] = [];
  rows: Row[] = [];
  rowCount: number | null = 0;

  async query(text: string, values?: unknown[]): Promise<PgQueryResult> {
    this.calls.push({ text, values });
    return { rows: this.rows, rowCount: this.rowCount };
  }

  async end(): Promise<void> {
    /* no-op */
  }
}

describe("PostgresAdapter", () => {
  it("rewrites ? placeholders to $n in order", () => {
    expect(toPgPlaceholders("WHERE a = ? AND b = ?")).toBe("WHERE a = $1 AND b = $2");
    expect(toPgPlaceholders("SELECT 1")).toBe("SELECT 1");
  });

  it("reads rows and binds positional params", async () => {
    const fake = new FakePg();
    fake.rows = [{ id: "p1", title: "Lost wallet" }];
    const adapter = new PostgresAdapter(fake);

    const row = await adapter.get<Row>("SELECT * FROM item_posts WHERE id = ?", ["p1"]);

    expect(row).toEqual({ id: "p1", title: "Lost wallet" });
    expect(fake.calls[0]).toEqual({
      text: "SELECT * FROM item_posts WHERE id = $1",
      values: ["p1"],
    });
  });

  it("returns all rows for list queries", async () => {
    const fake = new FakePg();
    fake.rows = [{ id: "a" }, { id: "b" }];
    const adapter = new PostgresAdapter(fake);

    await expect(adapter.all("SELECT * FROM users")).resolves.toEqual([{ id: "a" }, { id: "b" }]);
    // No params => single-argument query call (supports multi-statement DDL).
    expect(fake.calls[0]!.values).toBeUndefined();
  });

  it("maps rowCount onto runResult changes", async () => {
    const fake = new FakePg();
    fake.rowCount = 3;
    const adapter = new PostgresAdapter(fake);

    await expect(adapter.runResult("UPDATE users SET avatar_url = ? WHERE id = ?", ["x", "u1"]))
      .resolves.toEqual({ changes: 3 });
  });

  it("treats a null rowCount as zero changes", async () => {
    const fake = new FakePg();
    fake.rowCount = null;
    const adapter = new PostgresAdapter(fake);
    await expect(adapter.run("DELETE FROM uploads WHERE id = ?", ["x"])).resolves.toBeUndefined();
  });

  it("drops and recreates the public schema on reset", async () => {
    const fake = new FakePg();
    const adapter = new PostgresAdapter(fake);

    await adapter.reset();

    const texts = fake.calls.map((c) => c.text);
    expect(texts).toContain("DROP SCHEMA IF EXISTS public CASCADE");
    expect(texts).toContain("CREATE SCHEMA public");
  });
});
