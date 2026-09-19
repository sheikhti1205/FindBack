import { describe, expect, it, vi } from "vitest";
import { findPossibleMatches } from "./possibleMatches";

const target = { id: "lost-1", type: "LOST", status: "OPEN", title: "black umbrella", description: "wooden handle", category: "Clothing", eventDate: null, locationLabel: null, locationLat: null, locationLng: null } as never;

describe("findPossibleMatches", () => {
  it("only compares with relevant open reports of the opposite type", async () => {
    const fetchCandidates = vi.fn().mockResolvedValue([]);
    await findPossibleMatches(target, { fetchCandidates, embed: vi.fn().mockResolvedValue([[1, 0]]) });
    expect(fetchCandidates).toHaveBeenCalledWith("FOUND");
  });

  it("embeds the target and candidates in one batch and caps at three", async () => {
    const candidates = ["a", "b", "c", "d"].map((id) => ({ id, type: "FOUND", status: "OPEN", title: "umbrella", description: "handle", category: "Clothing", eventDate: null, locationLabel: null, locationLat: null, locationLng: null }));
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

  it("caps the candidate pool at 20, the spec min(OPEN opposite-type, 20) (WP8 #5)", async () => {
    const make = (id: string) => ({ id, type: "FOUND", status: "OPEN", title: "umbrella", description: "handle", category: "Clothing", eventDate: null, locationLabel: null, locationLat: null, locationLng: null });
    const candidates = Array.from({ length: 25 }, (_, i) => make(`c${i}`));
    const vectors = Array.from({ length: 26 }, () => [1, 0]);
    const embed = vi.fn().mockResolvedValue(vectors);
    const result = await findPossibleMatches(target, { fetchCandidates: vi.fn().mockResolvedValue(candidates), embed });
    expect(result.candidatesConsidered).toBe(20);
    expect(embed.mock.calls[0]![0]).toHaveLength(21);
  });
});