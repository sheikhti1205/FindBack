import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPDATE_PREFERENCES,
  UPDATE_DISMISSED_STORAGE_KEY,
  UPDATE_PREFS_STORAGE_KEY,
  dismissRelease,
  isReleaseDismissed,
  loadDismissedReleases,
  loadUpdatePreferences,
  saveUpdatePreferences,
} from "./preferences";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    raw: (key: string) => data.get(key) ?? null,
  };
}

describe("update preferences", () => {
  it("keeps unsolicited update popups OFF by default", () => {
    expect(loadUpdatePreferences(memoryStorage())).toEqual(DEFAULT_UPDATE_PREFERENCES);
    expect(loadUpdatePreferences(null)).toEqual({ popupEnabled: false });
    // The default is never "quietly turned on" by a missing key.
    expect(DEFAULT_UPDATE_PREFERENCES.popupEnabled).toBe(false);
  });

  it("treats a corrupt or unreadable value as no saved preference, not consent", () => {
    expect(loadUpdatePreferences(memoryStorage({ [UPDATE_PREFS_STORAGE_KEY]: "{not json" }))).toEqual(
      { popupEnabled: false },
    );
    expect(
      loadUpdatePreferences(memoryStorage({ [UPDATE_PREFS_STORAGE_KEY]: JSON.stringify({ popupEnabled: "yes" }) })),
    ).toEqual({ popupEnabled: false });
  });

  it("persists an explicit choice", () => {
    const storage = memoryStorage();
    saveUpdatePreferences({ popupEnabled: true }, storage);
    expect(loadUpdatePreferences(storage)).toEqual({ popupEnabled: true });
    saveUpdatePreferences({ popupEnabled: false }, storage);
    expect(loadUpdatePreferences(storage)).toEqual({ popupEnabled: false });
  });

  it("does not throw when storage refuses to write", () => {
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => saveUpdatePreferences({ popupEnabled: true }, blocked)).not.toThrow();
    expect(() => dismissRelease("release-a", blocked)).not.toThrow();
  });
});

describe("release dismissal", () => {
  it("persists a dismissal and is idempotent", () => {
    const storage = memoryStorage();
    expect(isReleaseDismissed("release-a", storage)).toBe(false);
    dismissRelease("release-a", storage);
    dismissRelease("release-a", storage);
    expect(loadDismissedReleases(storage)).toEqual(["release-a"]);
    expect(isReleaseDismissed("release-a", storage)).toBe(true);
    // A different release is unaffected: a later release may still appear.
    expect(isReleaseDismissed("release-b", storage)).toBe(false);
  });

  it("drops non-string and duplicate entries instead of trusting them", () => {
    const storage = memoryStorage({
      [UPDATE_DISMISSED_STORAGE_KEY]: JSON.stringify({
        releaseIds: ["a", 7, null, " a ", "b", "b"],
      }),
    });
    expect(loadDismissedReleases(storage)).toEqual(["a", "b"]);
  });

  it("treats an unreadable dismissal list as empty", () => {
    expect(loadDismissedReleases(memoryStorage({ [UPDATE_DISMISSED_STORAGE_KEY]: "{" }))).toEqual([]);
    expect(loadDismissedReleases(memoryStorage({ [UPDATE_DISMISSED_STORAGE_KEY]: '[ "a" ]' }))).toEqual([]);
  });

  it("never forgets an older release after many newer dismissals", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 75; index += 1) {
      dismissRelease(`release-${index}`, storage);
    }
    const kept = loadDismissedReleases(storage);
    expect(kept).toHaveLength(75);
    expect(kept[0]).toBe("release-0");
    expect(isReleaseDismissed("release-0", storage)).toBe(true);
  });

  it("ignores a blank release id", () => {
    const storage = memoryStorage();
    expect(dismissRelease("   ", storage)).toEqual([]);
    expect(loadDismissedReleases(storage)).toEqual([]);
  });
});
