import { describe, expect, it } from "vitest";
import {
  MemoryTransferStore,
  TransferCancelledError,
  throwIfCancelled,
} from "./transferStore";

const encoder = new TextEncoder();

describe("MemoryTransferStore", () => {
  it("stages temp chunks and reports the resume offset", () => {
    const store = new MemoryTransferStore();
    expect(store.tempBytes("entry")).toBe(0);
    store.appendTemp("entry", encoder.encode("hello "));
    store.appendTemp("entry", encoder.encode("world"));
    expect(store.tempBytes("entry")).toBe(11);
    expect(store.installedBytes("entry")).toBeNull();
  });

  it("commits atomically and replays installed chunks in order", () => {
    const store = new MemoryTransferStore();
    store.appendTemp("entry", encoder.encode("ab"));
    store.appendTemp("entry", encoder.encode("c"));
    store.commitTemp("entry");
    expect(store.tempBytes("entry")).toBe(0);
    expect(store.installedBytes("entry")).toBe(3);
    const seen: string[] = [];
    const decoder = new TextDecoder();
    store.readInstalled("entry", (chunk) => seen.push(decoder.decode(chunk)));
    expect(seen.join("")).toBe("abc");
  });

  it("refuses to commit with no staged prefix", () => {
    const store = new MemoryTransferStore();
    expect(() => store.commitTemp("missing")).toThrow();
  });

  it("discards temp without touching installed bytes", () => {
    const store = new MemoryTransferStore();
    store.seedInstalled("entry", [encoder.encode("old")]);
    store.appendTemp("entry", encoder.encode("new"));
    store.discardTemp("entry");
    expect(store.tempBytes("entry")).toBe(0);
    expect(store.installedBytes("entry")).toBe(3);
  });

  it("replays staged temp chunks for resume re-hashing", () => {
    const store = new MemoryTransferStore();
    store.appendTemp("entry", encoder.encode("ab"));
    store.appendTemp("entry", encoder.encode("c"));
    const seen: string[] = [];
    const decoder = new TextDecoder();
    store.readTemp("entry", (chunk) => seen.push(decoder.decode(chunk)));
    expect(seen.join("")).toBe("abc");
    expect(() => store.readTemp("missing", () => undefined)).toThrow();
  });

  it("deletes installed bytes and reports free space", () => {
    const store = new MemoryTransferStore({ freeBytes: 700 * 1024 * 1024 });
    expect(store.freeBytes()).toBe(700 * 1024 * 1024);
    store.seedInstalled("entry", [encoder.encode("x")]);
    store.deleteInstalled("entry");
    expect(store.installedBytes("entry")).toBeNull();
    expect(() =>
      store.readInstalled("entry", () => undefined),
    ).toThrow();
    store.setFreeBytes(null);
    expect(store.freeBytes()).toBeNull();
  });
});

describe("throwIfCancelled", () => {
  it("throws only when the control reports cancellation", () => {
    expect(() => throwIfCancelled(undefined)).not.toThrow();
    expect(() => throwIfCancelled({ isCancelled: () => false })).not.toThrow();
    expect(() => throwIfCancelled({ isCancelled: () => true })).toThrow(
      TransferCancelledError,
    );
  });
});
