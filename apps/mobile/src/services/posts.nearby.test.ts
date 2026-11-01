import { beforeEach, describe, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./supabaseClient", async original => ({
  ...await original<typeof import("./supabaseClient")>(), getSupabase: () => ({ rpc: io.rpc }),
}));
import { fetchFeed, type FeedFilters } from "./posts";
beforeEach(() => io.rpc.mockReset().mockResolvedValue({ data: [], error: null }));
describe("nearby report read boundary", () => {
  it("forwards the explicit rounded scope with ordinary category/date/query filters", async () => {
    await fetchFeed({ nearLat: 23.781, nearLng: 90.408, radiusM: 5000,
      type: "FOUND", category: "Electronics", status: "OPEN", q: "wallet", dateFrom: "2026-10-01", dateTo: "2026-10-31", sort: "oldest" });
    expect(io.rpc).toHaveBeenCalledWith("findback_query_posts_nearby_client", expect.objectContaining({
      p_near_lat: 23.781, p_near_lng: 90.408, p_radius_m: 5000, p_type: "FOUND", p_category: "Electronics",
      p_status: "OPEN", p_q: "wallet", p_date_from: "2026-10-01", p_date_to: "2026-10-31", p_order: "asc", p_limit: 11,
    }));
  });
  it.each<FeedFilters>([
    { radiusM: 5000 }, { nearLat: 23.781, radiusM: 5000 }, { nearLng: 90.408, radiusM: 5000 },
    { nearLat: Number.NaN, nearLng: 90.408, radiusM: 5000 },
    { nearLat: 23.781, nearLng: Number.POSITIVE_INFINITY, radiusM: 5000 },
    { nearLat: 23.781, nearLng: 90.408, radiusM: 0 },
  ])("keeps partial or non-finite scope on the ordinary query path: %j", async scope => {
    await fetchFeed({ ...scope, q: "wallet" });
    expect(io.rpc).toHaveBeenCalledWith("findback_query_posts_client", expect.objectContaining({ p_q: "wallet" }));
    expect(io.rpc.mock.calls[0]![1]).not.toHaveProperty("p_near_lat");
  });
});
