/**
 * Journal file tests (B1): v1 round-trip, atomic write shape, tolerant
 * read, and resume-offset reconciliation. Fake in-memory fs — no I/O.
 */
import { describe, expect, it } from "vitest";
import {
  JOURNAL_VERSION,
  buildJournal,
  journalPathFor,
  readJournal,
  resolveResumeOffset,
  writeJournal,
  type JournalFile,
  type JournalFs,
  type JournalWriteInput,
} from "./journal";

function memoryFs(files: Record<string, Uint8Array> = {}): JournalFs & {
  store: Record<string, Uint8Array>;
  writes: string[];
} {
  const store: Record<string, Uint8Array> = { ...files };
  const writes: string[] = [];
  return {
    store,
    writes,
    writeFile: async (path: string, data: Uint8Array) => {
      writes.push(path);
      store[path] = data.slice();
    },
    readFile: async (path: string) => {
      const found = store[path];
      if (found === undefined) throw new Error("missing file");
      return found.slice();
    },
    rename: async (from: string, to: string) => {
      const found = store[from];
      if (found === undefined) throw new Error("missing tmp");
      store[to] = found;
      delete store[from];
    },
    unlink: async (path: string) => {
      delete store[path];
    },
  };
}

const INPUT: JournalWriteInput = {
  modelId: "smolvlm2-500m-vision",
  revision: "dad030b6",
  filePath: "model.litertlm",
  url: "https://cdn.example.com/m.litertlm",
  offset: 123456,
  total: 987654321,
  sha: "b".repeat(64),
};

describe("journal file", () => {
  it("derives the sidecar path from the staging path", () => {
    expect(journalPathFor("/root/staging/m/r/f")).toBe("/root/staging/m/r/f.journal.json");
  });

  it("round-trips v1 through write then read", async () => {
    const fs = memoryFs();
    const written = await writeJournal(fs, "/s/stage", INPUT);
    expect(written.v).toBe(JOURNAL_VERSION);
    const read = await readJournal(fs, "/s/stage");
    expect(read).toMatchObject({
      v: 1,
      modelId: INPUT.modelId,
      url: INPUT.url,
      offset: 123456,
      total: 987654321,
      sha: INPUT.sha,
    });
    expect(typeof read?.updatedAt).toBe("string");
  });

  it("writes atomically via tmp plus rename", async () => {
    const fs = memoryFs();
    await writeJournal(fs, "/s/stage", INPUT);
    expect(fs.writes).toEqual(["/s/stage.journal.json.tmp"]);
    expect(fs.store["/s/stage.journal.json.tmp"]).toBeUndefined();
    expect(fs.store["/s/stage.journal.json"]).toBeDefined();
  });

  it("reads null for a missing journal", async () => {
    expect(await readJournal(memoryFs(), "/s/stage")).toBeNull();
  });

  it("reads null for corrupt json, wrong version, or bad shape", async () => {
    const enc = (text: string) => new TextEncoder().encode(text);
    const cases: Record<string, Uint8Array> = {
      "/s/a.journal.json": enc("not json{{{"),
      "/s/b.journal.json": enc(JSON.stringify({ v: 999, url: "u" })),
      "/s/c.journal.json": enc(JSON.stringify({ v: 1, url: "u" })),
      "/s/d.journal.json": enc(
        JSON.stringify({ ...buildJournal(INPUT), offset: -3 }),
      ),
    };
    for (const staging of ["/s/a", "/s/b", "/s/c", "/s/d"]) {
      expect(await readJournal(memoryFs(cases), staging)).toBeNull();
    }
  });

  it("resumes from the journal when the file agrees", () => {
    const journal = buildJournal(INPUT);
    expect(resolveResumeOffset(journal, 123456)).toEqual({
      offset: 123456,
      restartHash: false,
    });
  });

  it("restarts from staged size when the journal runs ahead", () => {
    const journal = buildJournal(INPUT);
    expect(resolveResumeOffset(journal, 100)).toEqual({
      offset: 100,
      restartHash: true,
    });
  });

  it("starts cold with no journal and restarts hash on orphan bytes", () => {
    expect(resolveResumeOffset(null, null)).toEqual({ offset: 0, restartHash: false });
    expect(resolveResumeOffset(null, 50)).toEqual({ offset: 50, restartHash: true });
  });

  it("keeps the journal type honest", () => {
    const journal: JournalFile = buildJournal({ ...INPUT, total: null });
    expect(journal.total).toBeNull();
    expect(journal.v).toBe(1);
  });
});
