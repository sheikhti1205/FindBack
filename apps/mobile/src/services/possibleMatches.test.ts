import { describe, expect, it, vi } from "vitest";
import { findPossibleMatches, resolveMatchingBackend } from "./possibleMatches";
import type { PostItem } from "@findback/shared";

const { fetchMatchCandidates } = vi.hoisted(() => ({ fetchMatchCandidates: vi.fn() }));
vi.mock("./posts", () => ({ MATCH_CANDIDATE_LIMIT: 20, fetchMatchCandidates }));

const target = { id: "lost-1", type: "LOST", status: "OPEN", title: "black umbrella", description: "wooden handle", category: "Clothing", eventDate: null, locationLabel: null, latitude: null, longitude: null } as never;

/**
 * A RAW candidate row, the way the feed reader returns it. The service
 * excludes the rows it must not compare BEFORE they are mapped to a
 * candidate, so the injected rows are raw posts, not candidates.
 */
function rawPost(id: string, overrides: Partial<PostItem> = {}): PostItem {
  return {
    id,
    title: "umbrella",
    description: "handle",
    category: "Clothing",
    eventDate: null,
    locationLabel: null,
    latitude: null,
    longitude: null,
    attachments: [],
    ...overrides,
  } as unknown as PostItem;
}

describe("findPossibleMatches", () => {
  it("uses the explicitly selected Needle service for the product matching batch", async () => {
    const result = await findPossibleMatches(target, {
      fetchCandidates: async () => [rawPost("found")],
      aiService: { matchingBackend: "needle", embedNeedle: async (texts: string[]) => texts.map(() => [1, 0]) },
    });
    expect(result.available).toBe(true);
    expect(result.matches[0]?.post.id).toBe("found");
  });
  it("retains the first image URL in the safe match-card projection", async () => {
    fetchMatchCandidates.mockResolvedValue([rawPost("found-1", { attachments: [
      { mimeType: "application/pdf", fileUrl: "https://example.com/document.pdf" },
      { mimeType: "image/jpeg", fileUrl: "https://example.com/photo.jpg" },
    ] } as never)]);
    const result = await findPossibleMatches(target, { embed: async () => [[1, 0], [1, 0]] });
    expect(result.matches[0]?.post).toMatchObject({ id: "found-1", photoUrl: "https://example.com/photo.jpg" });
  });
  it("only compares with relevant open reports of the opposite type", async () => {
    const fetchCandidates = vi.fn().mockResolvedValue([]);
    await findPossibleMatches(target, { fetchCandidates, embed: vi.fn().mockResolvedValue([[1, 0]]) });
    expect(fetchCandidates).toHaveBeenCalledWith("FOUND");
  });

  it("embeds the target and candidates in one batch and caps at three", async () => {
    const candidates = ["a", "b", "c", "d"].map((id) => rawPost(id));
    const embed = vi.fn().mockResolvedValue([[1, 0], [1, 0], [1, 0], [1, 0], [1, 0]]);
    const result = await findPossibleMatches(target, { fetchCandidates: vi.fn().mockResolvedValue(candidates), embed });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(result.matches).toHaveLength(3);
    expect(result.candidatesConsidered).toBe(4);
    expect(result.available).toBe(true);
  });

  it("reports unavailability instead of throwing when the embedder is missing", async () => {
    const result = await findPossibleMatches(target, { fetchCandidates: vi.fn().mockResolvedValue([]), embed: vi.fn().mockRejectedValue(new Error("MODEL_UNAVAILABLE")) });
    expect(result).toEqual({ matches: [], candidatesConsidered: 0, available: false, unavailableReason: "embed" });
  });

  it("caps the candidate pool at 20, the spec min(OPEN opposite-type, 20)", async () => {
    const candidates = Array.from({ length: 25 }, (_, i) => rawPost(`c${i}`));
    // The embedder is called with 21 texts (1 target + 20 capped candidates) and
    // must answer with exactly 21 vectors — surplus vectors are not a valid payload.
    const vectors = Array.from({ length: 21 }, () => [1, 0]);
    const embed = vi.fn().mockResolvedValue(vectors);
    const result = await findPossibleMatches(target, { fetchCandidates: vi.fn().mockResolvedValue(candidates), embed });
    expect(result.candidatesConsidered).toBe(20);
    expect(embed.mock.calls[0]![0]).toHaveLength(21);
  });

  it("asks the reader for a wider raw window, so the excluded rows do not shrink the pool", async () => {
    // The O5 exclusion runs on the client until the server-side candidate
    // reader exists, so the raw window is wider than the pool: the compared
    // set stays the size the server-side end state would give.
    fetchMatchCandidates.mockResolvedValue([]);
    await findPossibleMatches(target, { embed: vi.fn().mockResolvedValue([[1, 0]]) });
    expect(fetchMatchCandidates).toHaveBeenCalledWith("FOUND", 40);
  });

  // Seam contract: vectors are validated BEFORE cosine. A short/malformed payload
  // must degrade to "unavailable", never to fabricated scores (cosine returns 0 for
  // a length mismatch, which maps to base 0.5 and passes MIN_COSINE_CUTOFF = 0.0).
  it("never fabricates matches when the embedder returns fewer vectors than inputs", async () => {
    const embed = vi.fn().mockResolvedValue([[1, 0]]); // target only; candidate vector missing
    const result = await findPossibleMatches(target, { fetchCandidates: vi.fn().mockResolvedValue([rawPost("c0")]), embed });
    expect(result.matches).toEqual([]);
    expect(result.available).toBe(false);
    expect(result.unavailableReason).toBe("embed");
  });

  it("never ranks non-finite or mismatched-dimension vectors", async () => {
    const fetchCandidates = vi.fn().mockResolvedValue([rawPost("c0")]);

    const nonFinite = await findPossibleMatches(target, { fetchCandidates, embed: vi.fn().mockResolvedValue([[1, 0], [Number.NaN, 0]]) });
    expect(nonFinite.available).toBe(false);
    expect(nonFinite.unavailableReason).toBe("embed");

    const mismatchedDim = await findPossibleMatches(target, { fetchCandidates, embed: vi.fn().mockResolvedValue([[1, 0], [1, 0, 0]]) });
    expect(mismatchedDim.available).toBe(false);
    expect(mismatchedDim.unavailableReason).toBe("embed");

    const emptyPayload = await findPossibleMatches(target, { fetchCandidates, embed: vi.fn().mockResolvedValue([]) });
    expect(emptyPayload.available).toBe(false);
    expect(emptyPayload.unavailableReason).toBe("embed");
  });
});

describe("matching engine selection (Lane E)", () => {
  it("stays on USE by default for missing/unknown backends", () => {
    expect(resolveMatchingBackend(undefined)).toBe("use");
    expect(resolveMatchingBackend(null)).toBe("use");
    expect(resolveMatchingBackend({})).toBe("use");
    expect(resolveMatchingBackend({ matchingBackend: "bogus" })).toBe("use");
    expect(resolveMatchingBackend({ matchingBackend: "use" })).toBe("use");
  });

  it("selects Needle only when explicitly set", () => {
    expect(resolveMatchingBackend({ matchingBackend: "needle" })).toBe("needle");
  });

  it("a failing Needle embedder degrades to unavailable, never a silent USE fallback", async () => {
    const result = await findPossibleMatches(target, {
      fetchCandidates: async () => [rawPost("found")],
      aiService: {
        matchingBackend: "needle",
        embedNeedle: async () => { throw new Error("Model is not installed and verified"); },
      },
    });
    expect(result).toEqual({ matches: [], candidatesConsidered: 0, available: false, unavailableReason: "embed" });
  });
});
