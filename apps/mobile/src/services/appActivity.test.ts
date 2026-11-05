import { describe, expect, it } from "vitest";
import { beginAppActivity, appActivityBusy, subscribeAppActivity, duringAppActivity } from "./appActivity";

describe("application interruption activity", () => {
  it("keeps concurrent work busy until every owner settles, with idempotent release", () => {
    const seen: boolean[] = []; const off = subscribeAppActivity(() => seen.push(appActivityBusy()));
    const a = beginAppActivity(), b = beginAppActivity();
    expect(appActivityBusy()).toBe(true); a(); a(); expect(appActivityBusy()).toBe(true);
    b(); expect(appActivityBusy()).toBe(false); off(); expect(seen).toEqual([true, true, true, false]);
  });
  it("tracks the full async lifetime and releases on rejection", async () => {
    let reject!: (e: Error) => void;
    const work = duringAppActivity(() => new Promise<void>((_, no) => { reject = no; }));
    expect(appActivityBusy()).toBe(true); reject(new Error("synthetic"));
    await expect(work).rejects.toThrow("synthetic"); expect(appActivityBusy()).toBe(false);
  });
});
