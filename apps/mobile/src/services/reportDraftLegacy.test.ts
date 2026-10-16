/**
 * §20: old drafts must still load. A draft written by an earlier build (or by
 * anything else that reached the same key) is restored by the running build, so
 * the loader reads a payload it did not write. What has to hold:
 *
 * - the text and the photos survive;
 * - fields the current shape does not know — the retired AI metadata — are
 *   dropped, not carried forward into state or re-saved;
 * - nothing in the payload can crash the restore or reach the form as the wrong
 *   type (a `.trim()` on a number is a blank screen);
 * - a payload that is not a draft is no draft.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { backing } = vi.hoisted(() => ({ backing: new Map<string, string>() }));

vi.mock("./storage", () => ({
  storage: {
    getItem: (key: string) => (backing.has(key) ? (backing.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  },
}));

import { clearDraft, draftIsMeaningful, loadDraft, saveDraft, type ReportDraft } from "./reportDraft";

const DRAFT_KEY = "findback:reportDraft:v1:u1";

/**
 * The retired AI metadata, in the shapes a build in between could have written.
 * The loader knows none of these names.
 */
const RETIRED_KEYS = [
  "vlmSummary",
  "aiSuggestions",
  "grounding",
  "modelId",
  "photoAi",
  "suggestedCategory",
  "descriptionSuggestions",
  "assistState",
  "confidence",
];

/** A draft from before the AI surfaces were removed, plus its photos. */
function legacyPayload(): Record<string, unknown> {
  return {
    type: "FOUND",
    title: "Black backpack",
    description: "blue tag on the zip",
    category: "Bags & Wallets",
    eventDate: "2026-08-01",
    location: { label: "Library steps", latitude: 51.5072, longitude: -0.1276 },
    youtubeUrl: "",
    photoId: "p1",
    photoNativeUri: null,
    photoWebPath: "blob:legacy-preview",
    photoFormat: "jpeg",
    photoIds: ["p1", "p2"],
    photoRefs: [{ id: "p1", format: "jpeg" }, { id: "p2" }],
    // Retired AI metadata a previous build wrote alongside the draft.
    vlmSummary: "a black backpack on a bench",
    aiSuggestions: { category: "Bags & Wallets", confidence: 0.94 },
    grounding: [{ label: "backpack", box: [1, 2, 3, 4] }],
    modelId: "qwen2.5-vl-3b-instruct",
    photoAi: { caption: "bench" },
    suggestedCategory: "Bags & Wallets",
    descriptionSuggestions: ["blue tag on the zip"],
    assistState: "ready",
    confidence: 0.94,
  };
}

function stored(): Record<string, unknown> {
  return JSON.parse(backing.get(DRAFT_KEY) as string) as Record<string, unknown>;
}

beforeEach(() => {
  // The loader caches in memory as well as in storage, so a test that only clears
  // the stored payload would keep reading the previous test's draft.
  backing.clear();
  clearDraft();
});

describe("restoring a draft written by an older build (§20)", () => {
  it("keeps the text and the photos", () => {
    backing.set(DRAFT_KEY, JSON.stringify(legacyPayload()));

    const draft = loadDraft("u1");

    expect(draft).toMatchObject({
      type: "FOUND",
      title: "Black backpack",
      description: "blue tag on the zip",
      category: "Bags & Wallets",
      eventDate: "2026-08-01",
      youtubeUrl: "",
      photoIds: ["p1", "p2"],
    });
    expect(draft?.location).toEqual({
      label: "Library steps",
      latitude: 51.5072,
      longitude: -0.1276,
    });
    expect(draft?.photoRefs).toEqual([{ id: "p1", format: "jpeg" }, { id: "p2" }]);
  });

  it("drops the retired AI metadata instead of carrying it into state", () => {
    backing.set(DRAFT_KEY, JSON.stringify(legacyPayload()));

    const draft = loadDraft("u1") as unknown as Record<string, unknown>;

    for (const key of RETIRED_KEYS) {
      expect(draft, `${key} survived the restore`).not.toHaveProperty(key);
    }
    // The restored shape is exactly what the form reads — nothing extra is
    // handed to it, so no later code can stumble onto a retired field.
    expect(Object.keys(draft).sort()).toEqual(
      [
        "category",
        "description",
        "eventDate",
        "location",
        "photoFormat",
        "photoId",
        "photoIds",
        "photoNativeUri",
        "photoRefs",
        "photoWebPath",
        "publishOutcome",
        "title",
        "type",
        "youtubeUrl",
      ].sort(),
    );
  });

  it("does not write the retired metadata back on the next autosave", () => {
    backing.set(DRAFT_KEY, JSON.stringify(legacyPayload()));

    const draft = loadDraft("u1") as ReportDraft;
    saveDraft({ ...draft, title: "Black backpack (blue tag)" }, "u1");

    const saved = stored();
    for (const key of RETIRED_KEYS) {
      expect(saved, `${key} was re-saved`).not.toHaveProperty(key);
    }
    expect(saved.title).toBe("Black backpack (blue tag)");
    expect(saved.photoIds).toEqual(["p1", "p2"]);
  });
});

describe("a draft that is not shaped the way the form expects (§20)", () => {
  it("coerces every field the form reads as a string, so nothing can throw", () => {
    backing.set(
      DRAFT_KEY,
      JSON.stringify({
        type: "FOUNDISH",
        title: 42,
        description: ["blue tag"],
        category: 7,
        eventDate: { at: "2026-08-01" },
        location: { label: 42, latitude: "north", longitude: "51.5" },
        youtubeUrl: null,
        photoId: 42,
        photoNativeUri: { uri: "content://x" },
        photoWebPath: false,
        photoFormat: 9,
        photoIds: ["p1", 42, null, "p2"],
        photoRefs: [{ id: "p1" }, { id: 42 }, null, "p3"],
      }),
    );

    const draft = loadDraft("u1");

    expect(draft).toEqual({
      publishOutcome: undefined,
      type: "LOST",
      title: "",
      description: "",
      category: "",
      eventDate: "",
      location: { label: "", latitude: null, longitude: 51.5 },
      youtubeUrl: "",
      photoId: null,
      photoNativeUri: null,
      photoWebPath: null,
      photoFormat: null,
      photoIds: ["p1", "p2"],
      photoRefs: [{ id: "p1" }],
    });
    // The two things that must survive a bad restore still do.
    expect(draft?.photoIds).toEqual(["p1", "p2"]);
    expect(() => draftIsMeaningful(draft)).not.toThrow();
    expect(draftIsMeaningful(draft)).toBe(false);
  });

  it("keeps a photo ref whose id is a string but whose URIs are the wrong type", () => {
    // The shape that reached the form as `{ id: "p1", nativeUri: 42 }` and then
    // threw inside `uri.startsWith("blob:")` on mount: a valid id is not proof
    // that the ref is usable, so its own fields are re-derived too.
    backing.set(
      DRAFT_KEY,
      JSON.stringify({
        title: "Phone",
        photoIds: ["p1"],
        photoRefs: [
          { id: "p1", nativeUri: 42, webPath: { href: "https://x" }, format: 7, size: "big", name: 9 },
        ],
      }),
    );

    expect(loadDraft("u1")?.photoRefs).toEqual([{ id: "p1" }]);
  });

  it("keeps the usable fields of a ref and only the string URIs", () => {
    backing.set(
      DRAFT_KEY,
      JSON.stringify({
        title: "Phone",
        photoIds: ["p1"],
        photoRefs: [
          {
            id: "p1",
            name: "a.jpg",
            size: 12,
            format: "jpg",
            motionPhoto: true,
            nativeUri: "content://keep",
            webPath: 42,
          },
        ],
      }),
    );

    expect(loadDraft("u1")?.photoRefs).toEqual([
      {
        id: "p1",
        name: "a.jpg",
        size: 12,
        format: "jpg",
        motionPhoto: true,
        nativeUri: "content://keep",
      },
    ]);
  });

  it("keeps a coordinate a legacy serializer stringified, and refuses one that is not a number", () => {
    backing.set(
      DRAFT_KEY,
      JSON.stringify({ title: "Keys", location: { label: "Gate", latitude: "51.5072", longitude: "" } }),
    );

    expect(loadDraft("u1")?.location).toEqual({ label: "Gate", latitude: 51.5072, longitude: null });
  });

  it("keeps a draft whose only photo is the legacy single-photo field", () => {
    backing.set(
      DRAFT_KEY,
      JSON.stringify({ title: "Umbrella", photoId: "legacy-1", photoWebPath: "blob:legacy" }),
    );

    const draft = loadDraft("u1");
    expect(draft?.photoId).toBe("legacy-1");
    expect(draft?.photoIds).toBeUndefined();
    expect(draft?.photoWebPath).toBe("blob:legacy");
  });

  it("treats a payload that is not a draft as no draft, without throwing", () => {
    for (const raw of [
      "42",
      '"a string"',
      "null",
      "true",
      "[1,2,3]",
      "{",
      '{"title": "x"',
      JSON.stringify(["p1", "p2"]),
    ]) {
      backing.set(DRAFT_KEY, raw);
      expect(loadDraft("u1"), `payload ${raw}`).toBeNull();
    }
  });

  it("survives a stored draft whose nested fields are the wrong kind of object", () => {
    backing.set(
      DRAFT_KEY,
      JSON.stringify({ title: "Phone", location: "somewhere", photoRefs: "p1", photoIds: "p1" }),
    );

    const draft = loadDraft("u1");
    expect(draft?.location).toEqual({ label: "", latitude: null, longitude: null });
    expect(draft?.photoRefs).toBeUndefined();
    expect(draft?.photoIds).toBeUndefined();
    expect(draft?.title).toBe("Phone");
  });
});
