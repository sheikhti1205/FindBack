// @vitest-environment jsdom
/**
 * CF-020 MINOR-2, the restore half: the helper sentence is persisted with the
 * draft, and the install copy this screen offers prescribes leaving the screen
 * and coming back — so the RESTORE branch of the loader is load-bearing, not
 * decoration.
 *
 * The round-3 review measured that deleting that branch survived the whole
 * suite: every existing test re-renders inside one module instance, so the
 * in-memory draft masked the stored-payload path. These cases therefore start
 * COLD — the payload is written straight into `localStorage` (what a previous
 * session left behind) and the module is re-imported, which is the only way to
 * exercise the reader the restore copy depends on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = "u1";
const KEY = `findback:reportDraft:v1:${ACCOUNT}`;

const STORED = {
  type: "LOST",
  title: "",
  description: "a black umbrella lost near the market",
  category: "",
  eventDate: "",
  location: { label: "", latitude: null, longitude: null },
  youtubeUrl: "",
  aiSuggestInput: "Black umbrella lost yesterday",
  photoId: null,
  photoNativeUri: null,
  photoWebPath: null,
  photoFormat: null,
};

describe("reportDraft — the helper sentence survives a cold start", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // A fresh module instance: no in-memory draft can answer `loadDraft` first.
    vi.resetModules();
  });

  it("restores the sentence a previous session persisted", async () => {
    window.localStorage.setItem(KEY, JSON.stringify(STORED));
    const { loadDraft } = await import("../services/reportDraft");
    expect(loadDraft(ACCOUNT)?.aiSuggestInput).toBe("Black umbrella lost yesterday");
  });

  it("does not materialise the key when the stored payload has no sentence", async () => {
    const { aiSuggestInput: _omitted, ...withoutSentence } = STORED;
    window.localStorage.setItem(KEY, JSON.stringify(withoutSentence));
    const { loadDraft } = await import("../services/reportDraft");

    const restored = loadDraft(ACCOUNT);
    expect(restored).not.toBeNull();
    // Not merely falsy: absent. `Object.keys()` counts a key whose value is
    // `undefined`, and a restored shape carrying a field the form never reads is
    // what turned the revision-2 loader into a BLOCKER.
    expect(restored && "aiSuggestInput" in restored).toBe(false);
  });
});
