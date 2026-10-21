// @vitest-environment jsdom
/**
 * Saved reports: the device list is the immediate truth, the account is a
 * best-effort adapter, and a payload that does not parse is discarded rather
 * than trusted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("./supabaseClient", () => ({ getSupabase: () => ({ rpc: rpcMock }) }));

import {
  SAVED_REPORTS_REMOVALS_STORAGE_PREFIX,
  SAVED_REPORTS_STORAGE_PREFIX,
  clearSavedReportRemoval,
  fetchSavedReportSnapshot,
  forgetSavedReports,
  isReportSaved,
  listSavedReportIdsFromServer,
  markSavedReportSynced,
  readSavedReportRemovals,
  readSavedReportState,
  readSavedReports,
  recordSavedReportRemoval,
  removeReportFromDevice,
  removeSavedReport,
  saveReportToDevice,
  saveReportOnServer,
  unsaveReportOnServer,
  writeSavedReport,
} from "./savedReports";

const KEY = (accountId: string) => `${SAVED_REPORTS_STORAGE_PREFIX}.${encodeURIComponent(accountId)}`;
const REMOVALS_KEY = (accountId: string) =>
  `${SAVED_REPORTS_REMOVALS_STORAGE_PREFIX}:${encodeURIComponent(accountId)}`;

/** The account's list, as the server sends it: an envelope, not a bare array. */
function envelope(
  items: Array<{ post_id: string; saved_at?: string }>,
  complete = true,
): { items: Array<{ post_id: string; saved_at: string }>; complete: boolean } {
  return {
    items: items.map((item) => ({
      post_id: item.post_id,
      saved_at: item.saved_at ?? "2026-10-20T10:00:00+00:00",
    })),
    complete,
  };
}

beforeEach(() => {
  localStorage.clear();
  rpcMock.mockReset();
  rpcMock.mockResolvedValue({ data: envelope([]), error: null });
});

afterEach(() => localStorage.clear());

describe("the device list", () => {
  it("stores a saved report and reads it back", () => {
    const written = writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ postId: "p1", title: "Lost keys", synced: false });
    expect(typeof written[0]!.savedAt).toBe("string");
    expect(readSavedReports("u1")).toEqual(written);
    expect(isReportSaved("u1", "p1")).toBe(true);
    expect(isReportSaved("u1", "p2")).toBe(false);
  });

  it("keeps one account's list away from another's", () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    expect(readSavedReports("u2")).toEqual([]);
    expect(isReportSaved("u2", "p1")).toBe(false);
    expect(localStorage.getItem(KEY("u1"))).toBeTruthy();
    expect(localStorage.getItem(KEY("u2"))).toBeNull();
  });

  it("discards a payload that does not parse instead of trusting it", () => {
    localStorage.setItem(KEY("u1"), "{not json");
    expect(readSavedReports("u1")).toEqual([]);
    expect(isReportSaved("u1", "p1")).toBe(false);
  });

  it("discards a payload that is not a list", () => {
    localStorage.setItem(KEY("u1"), JSON.stringify({ postId: "p1" }));
    expect(readSavedReports("u1")).toEqual([]);
  });

  it("drops a record that is not shaped like a record and keeps the good ones", () => {
    localStorage.setItem(
      KEY("u1"),
      JSON.stringify([
        { postId: "p1", title: "Lost keys", savedAt: "2026-10-20T10:00:00.000Z", synced: false },
        { postId: "", title: "No id", savedAt: "2026-10-20T10:00:00.000Z", synced: false },
        { postId: "p3", title: "No time", synced: false },
        { postId: "p4", title: "Not a boolean", savedAt: "2026-10-20T10:00:00.000Z", synced: "yes" },
        "nonsense",
      ]),
    );
    const entries = readSavedReports("u1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.postId).toBe("p1");
  });

  it("removes a saved report", () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    writeSavedReport("u1", { postId: "p2", title: "Found cat" });
    const next = removeSavedReport("u1", "p1");
    expect(next.map((entry) => entry.postId)).toEqual(["p2"]);
    expect(isReportSaved("u1", "p1")).toBe(false);
    expect(readSavedReports("u1")).toHaveLength(1);
  });

  it("keeps the first saved moment when the same report is saved again", () => {
    const first = writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    const again = writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    expect(again).toHaveLength(1);
    expect(again[0]!.savedAt).toBe(first[0]!.savedAt);
  });

  it("waits for the account to confirm again when the title changed", () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    markSavedReportSynced("u1", "p1", true);
    expect(readSavedReports("u1")[0]!.synced).toBe(true);
    const changed = writeSavedReport("u1", { postId: "p1", title: "Lost keys (updated)" });
    expect(changed[0]!.synced).toBe(false);
  });

  it("marks a record as synced", () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    const synced = markSavedReportSynced("u1", "p1", true);
    expect(synced[0]!.synced).toBe(true);
    expect(readSavedReports("u1")[0]!.synced).toBe(true);
  });

  it("writes the whole session list down when it marks a record as synced", () => {
    // The browser refused the save, so the disk has nothing and the session
    // has the list.
    const session = {
      entries: [
        { postId: "p1", title: "Lost keys", savedAt: "2026-10-20T10:00:00.000Z", synced: false },
        { postId: "p2", title: "Found cat", savedAt: "2026-10-20T11:00:00.000Z", synced: false },
      ],
      removed: [],
    };
    const synced = markSavedReportSynced("u1", "p1", true, session);
    expect(synced.map((entry) => entry.postId).sort()).toEqual(["p1", "p2"]);
    // The store recovered: it received the WHOLE list, not just p1.
    expect(readSavedReports("u1").map((entry) => entry.postId).sort()).toEqual(["p1", "p2"]);
    expect(readSavedReports("u1").find((entry) => entry.postId === "p1")!.synced).toBe(true);
  });

  it("forgets a record without recording a removal intent", () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    writeSavedReport("u1", { postId: "p2", title: "Found cat" });
    const result = forgetSavedReports("u1", ["p1"]);
    expect(result.entries.map((entry) => entry.postId)).toEqual(["p2"]);
    expect(result.removals).toEqual([]);
    expect(readSavedReports("u1").map((entry) => entry.postId)).toEqual(["p2"]);
    // There is nothing to unsave: the account dropped it, so no intent is kept.
    expect(readSavedReportRemovals("u1")).toEqual([]);
  });

  it("does not let a settled intent hide the report", () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    recordSavedReportRemoval("u1", "p1");
    // The account settled the intent, but the disk still holds the tombstone.
    const state = readSavedReportState("u1", {
      entries: [],
      removed: [{ postId: "p1", removedAt: "2026-10-20T10:00:00.000Z" }],
      settled: ["p1"],
    });
    expect(state.removals).toEqual([]);
    expect(state.entries.map((entry) => entry.postId)).toEqual(["p1"]);
  });

  it("refuses a post id that is not a usable id", () => {
    expect(writeSavedReport("u1", { postId: "  ", title: "Nothing" })).toEqual([]);
    expect(readSavedReports("u1")).toEqual([]);
  });
});

describe("the removal intents", () => {
  it("records a removal and keeps it until the account drops the report", () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    const result = removeReportFromDevice("u1", "p1");

    expect(result.entries).toHaveLength(0);
    expect(result.persisted).toBe(true);
    expect(result.removals.map((removal) => removal.postId)).toEqual(["p1"]);
    expect(readSavedReportRemovals("u1")).toHaveLength(1);
    expect(readSavedReports("u1")).toHaveLength(0);
  });

  it("keeps one account's intents away from another's", () => {
    recordSavedReportRemoval("u1", "p1");
    expect(readSavedReportRemovals("u2")).toEqual([]);
  });

  it("drops an intent that is settled", () => {
    recordSavedReportRemoval("u1", "p1");
    const cleared = clearSavedReportRemoval("u1", "p1");
    expect(cleared.removals).toEqual([]);
    expect(cleared.persisted).toBe(true);
    expect(readSavedReportRemovals("u1")).toEqual([]);
  });

  it("says the drop did not reach the disk when the browser refuses it", () => {
    recordSavedReportRemoval("u1", "p1");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      const cleared = clearSavedReportRemoval("u1", "p1");
      expect(cleared.persisted).toBe(false);
      // The tombstone is still on the disk: the caller has to remember that
      // the intent is settled.
      expect(readSavedReportRemovals("u1")).toHaveLength(1);
    } finally {
      setItem.mockRestore();
    }
  });

  it("cancels the intent when the report is saved again", () => {
    recordSavedReportRemoval("u1", "p1");
    const result = saveReportToDevice("u1", { postId: "p1", title: "Lost keys" });
    expect(result.removals).toEqual([]);
    expect(readSavedReportRemovals("u1")).toEqual([]);
    expect(result.entries.map((entry) => entry.postId)).toEqual(["p1"]);
  });

  it("discards an intent that does not parse instead of trusting it", () => {
    localStorage.setItem(REMOVALS_KEY("u1"), JSON.stringify([{ postId: "p1" }, "nonsense"]));
    expect(readSavedReportRemovals("u1")).toEqual([]);
  });

  it("says the write was not durable when the browser refuses it", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      const result = saveReportToDevice("u1", { postId: "p1", title: "Lost keys" });
      expect(result.persisted).toBe(false);
      // The session still holds the save; the disk does not.
      expect(result.entries.map((entry) => entry.postId)).toEqual(["p1"]);
      expect(readSavedReports("u1")).toEqual([]);
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("the account adapter", () => {
  it("answers true only when the account confirmed the save", async () => {
    rpcMock.mockResolvedValueOnce({ data: true, error: null });
    await expect(saveReportOnServer("p1")).resolves.toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("findback_save_post_client", { p_post_id: "p1" });
  });

  it("degrades to local-only when the account call fails, and never throws", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "function does not exist" } });
    await expect(saveReportOnServer("p1")).resolves.toBe(false);
    rpcMock.mockRejectedValueOnce(new Error("offline"));
    await expect(saveReportOnServer("p1")).resolves.toBe(false);
  });

  it("degrades to local-only when the remove call fails, and never throws", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "nope" } });
    await expect(unsaveReportOnServer("p1")).resolves.toBe(false);
    rpcMock.mockRejectedValueOnce(new Error("offline"));
    await expect(unsaveReportOnServer("p1")).resolves.toBe(false);
  });

  it("lists the account's saved ids and drops rows it cannot read", async () => {
    rpcMock.mockResolvedValueOnce({
      data: [
        { post_id: "p1", created_at: "2026-10-20T10:00:00+00:00" },
        { post_id: "", created_at: "2026-10-20T10:00:00+00:00" },
        { post_id: "p2" },
      ],
      error: null,
    });
    await expect(listSavedReportIdsFromServer()).resolves.toEqual(["p1", "p2"]);
    expect(rpcMock).toHaveBeenCalledWith("findback_list_saved_posts_client");
  });

  it("says the account could not be reached instead of pretending it is empty", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "does not exist" } });
    const snapshot = await fetchSavedReportSnapshot();
    expect(snapshot.ok).toBe(false);
    expect(snapshot.ids).toEqual([]);
    rpcMock.mockRejectedValueOnce(new Error("offline"));
    const failed = await fetchSavedReportSnapshot();
    expect(failed.ok).toBe(false);
  });

  it("reports the account's saved moment next to each id", async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ post_id: "p1", created_at: "2026-10-20T10:00:00+00:00" }],
      error: null,
    });
    const snapshot = await fetchSavedReportSnapshot();
    expect(snapshot.ok).toBe(true);
    expect(snapshot.savedAts.p1).toBe("2026-10-20T10:00:00+00:00");
  });
});

describe("the account's list arrives as an envelope", () => {
  it("reads the ids and the saved moments out of the envelope", async () => {
    rpcMock.mockResolvedValueOnce({
      data: envelope([{ post_id: "p1" }, { post_id: "p2" }]),
      error: null,
    });
    const snapshot = await fetchSavedReportSnapshot();
    expect(snapshot.ok).toBe(true);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.ids).toEqual(["p1", "p2"]);
    expect(snapshot.savedAts.p1).toBe("2026-10-20T10:00:00+00:00");
  });

  it("never claims a complete list it was not told about", async () => {
    rpcMock.mockResolvedValueOnce({ data: { items: [{ post_id: "p1" }] }, error: null });
    const missing = await fetchSavedReportSnapshot();
    expect(missing.ok).toBe(true);
    expect(missing.complete).toBe(false);

    rpcMock.mockResolvedValueOnce({
      data: { items: [{ post_id: "p1" }], complete: "yes" },
      error: null,
    });
    const notABoolean = await fetchSavedReportSnapshot();
    expect(notABoolean.ok).toBe(true);
    expect(notABoolean.complete).toBe(false);
  });

  it("never claims a complete list it had to repair", async () => {
    rpcMock.mockResolvedValueOnce({
      data: { items: [{ post_id: "p1" }, { post_id: "" }], complete: true },
      error: null,
    });
    const snapshot = await fetchSavedReportSnapshot();
    expect(snapshot.ids).toEqual(["p1"]);
    // The list is missing a report, so it is not the whole list.
    expect(snapshot.complete).toBe(false);
  });

  it("reads the older bare-array list, but never as a complete one", async () => {
    rpcMock.mockResolvedValueOnce({
      data: [{ post_id: "p1", created_at: "2026-10-20T10:00:00+00:00" }],
      error: null,
    });
    const snapshot = await fetchSavedReportSnapshot();
    expect(snapshot.ok).toBe(true);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.ids).toEqual(["p1"]);
  });

  it("reports a failure instead of pretending the account holds nothing", async () => {
    rpcMock.mockResolvedValueOnce({ data: { items: "nope" }, error: null });
    const broken = await fetchSavedReportSnapshot();
    expect(broken.ok).toBe(false);
    expect(broken.complete).toBe(false);
    expect(broken.ids).toEqual([]);

    rpcMock.mockResolvedValueOnce({ data: { nope: [] }, error: null });
    const shapeless = await fetchSavedReportSnapshot();
    expect(shapeless.ok).toBe(false);
    expect(shapeless.complete).toBe(false);
  });

  it("keeps every id the account holds, however many there are", async () => {
    const items = Array.from({ length: 201 }, (_, index) => ({ post_id: `p${index + 1}` }));
    rpcMock.mockResolvedValueOnce({ data: envelope(items), error: null });
    const snapshot = await fetchSavedReportSnapshot();
    expect(snapshot.ids).toHaveLength(201);
    expect(snapshot.complete).toBe(true);
  });
});
