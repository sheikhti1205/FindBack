// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { PostItem } from "@findback/shared";
import { findPossibleMatches } from "../services/possibleMatches";

/** Ownership moved from the interim client block flag to the server reader.
 * Real block/own-row/type/status/limit tests now execute in
 * supabase/tests/verify_20261022160000_match_candidates_reader.sql B1-B9.
 * These tests deliberately claim only the consumer's returned-pool contract;
 * an injected pool cannot stand in for proving the database's exclusion. */
const target = {
  id: "lost-1", type: "LOST", status: "OPEN", title: "black umbrella",
  description: "wooden handle", category: "Clothing", eventDate: null,
  locationLabel: null, latitude: null, longitude: null,
} as unknown as PostItem;
const candidate = (id: string) => ({ ...target, id, type: "FOUND", title: `umbrella ${id}`, attachments: [] }) as PostItem;
const embedder = () => vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));

describe("Possible Matches — server-owned candidate pool", () => {
  it("asks about the target id, never an invented type filter", async () => {
    const fetchCandidates = vi.fn(async () => [candidate("found-open")]);
    await findPossibleMatches(target, { fetchCandidates, embed: embedder() });
    expect(fetchCandidates).toHaveBeenCalledExactlyOnceWith("lost-1");
  });

  it("ranks the eligible rows returned by the server", async () => {
    const result = await findPossibleMatches(target, { fetchCandidates: async () => [candidate("found-open")], embed: embedder() });
    expect(result.available).toBe(true);
    expect(result.matches.map((m) => m.post.id)).toEqual(["found-open"]);
  });

  it("embeds exactly the target plus the returned pool", async () => {
    const embed = embedder();
    await findPossibleMatches(target, { fetchCandidates: async () => [candidate("one"), candidate("two")], embed });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]![0]).toHaveLength(3);
    expect(embed.mock.calls[0]![0].join(" | ")).toContain("umbrella one");
    expect(embed.mock.calls[0]![0].join(" | ")).toContain("umbrella two");
  });

  it("counts the actual returned rows compared, not the total of a larger server query", async () => {
    const result = await findPossibleMatches(target, { fetchCandidates: async () => [candidate("one"), candidate("two")], embed: embedder() });
    expect(result.candidatesConsidered).toBe(2);
  });

  it("applies no block predicate of its own: the server's pool is the pool", async () => {
    const embed = embedder();
    const result = await findPossibleMatches(target, {
      fetchCandidates: async () => [{ ...candidate("flagged"), blockedAuthor: true }], embed,
    });
    expect(result.candidatesConsidered).toBe(1);
    expect(result.matches.map((match) => match.post.id)).toEqual(["flagged"]);
    expect(embed.mock.calls[0]![0]).toHaveLength(2);
  });

  it("keeps an empty eligible pool available, without claiming why it is empty", async () => {
    const result = await findPossibleMatches(target, { fetchCandidates: async () => [], embed: embedder() });
    expect(result).toEqual({ available: true, matches: [], candidatesConsidered: 0 });
  });

  it("does not silently fall back to the feed when the required reader fails", async () => {
    const embed = embedder();
    const result = await findPossibleMatches(target, { fetchCandidates: async () => { throw new Error("reader unavailable"); }, embed });
    expect(result).toEqual({ available: false, unavailableReason: "candidates", matches: [], candidatesConsidered: 0 });
    expect(embed).not.toHaveBeenCalled();
  });

  it("caps an injected pool at twenty and never embeds beyond it", async () => {
    const embed = embedder();
    const result = await findPossibleMatches(target, {
      fetchCandidates: async () => Array.from({ length: 25 }, (_, i) => candidate(`found-${i}`)), embed,
    });
    expect(result.candidatesConsidered).toBe(20);
    expect(embed.mock.calls[0]![0]).toHaveLength(21);
    expect(embed.mock.calls[0]![0].join(" | ")).not.toContain("umbrella found-20");
  });
});
