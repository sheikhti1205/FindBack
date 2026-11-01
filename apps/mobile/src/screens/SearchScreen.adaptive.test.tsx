// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFeedCaches } from "../hooks/feedCache";
import { clearNearbySession, getNearbySession } from "../services/nearby";
import { resetBackInterceptors, consumeBackIntercept } from "../components/backNavigation";
import { resetModalLayers } from "../hooks/modalLayers";

const io = vi.hoisted(() => ({
  feed: vi.fn(), position: vi.fn(), permission: vi.fn(),
  user: { id: "search-a" } as { id: string } | null,
}));
vi.mock("../services/posts", () => ({ fetchFeed: io.feed }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: io.user }) }));
vi.mock("../components/TabTap", () => ({ useTabTap: () => ({ tapCount: 0 }) }));
vi.mock("../services/locationAdapter", async original => ({
  ...await original<typeof import("../services/locationAdapter")>(),
  createProductionLocationAdapter: () => ({ getPermission: io.permission, getCurrentPosition: io.position }),
}));
vi.mock("../services/people", async original => ({
  ...await original<typeof import("../services/people")>(), searchPeople: async () => ({ items: [], nextCursor: null }),
}));
import { SearchScreen } from "./SearchScreen";

function Probe() { const l = useLocation(); return <output data-testid="route">{l.pathname + l.search}</output>; }
function tree(path = "/search") { return <MemoryRouter initialEntries={[path]}><SearchScreen nlExtract={async () => ({})} /><Probe /></MemoryRouter>; }
const width = window.innerWidth;
beforeEach(() => {
  window.innerWidth = 1000;
  clearFeedCaches(); clearNearbySession();
  io.user = { id: "search-a" };
  io.feed.mockReset().mockResolvedValue({ items: [], total: 0, nextCursor: null });
  io.permission.mockReset().mockResolvedValue("granted");
  io.position.mockReset().mockResolvedValue({ latitude: 23.780612, longitude: 90.407831, accuracyMeters: 80 });
});
afterEach(() => { cleanup(); clearFeedCaches(); clearNearbySession(); resetBackInterceptors(); resetModalLayers(); window.innerWidth = width; });
async function openFilters() {
  const trigger = screen.getByRole("button", { name: /^Filters/ });
  act(() => trigger.focus()); fireEvent.click(trigger);
  return screen.findByRole("dialog", { name: "Filters" });
}
describe("adaptive report filters", () => {
  it.each([320, 700, 1200])("dismisses filters at %spx without losing query or focus", async w => {
    window.innerWidth = w; render(tree("/search?q=wallet"));
    const trigger = screen.getByRole("button", { name: "Filters" });
    const dialog = await openFilters();
    expect(within(dialog).getByLabelText("From date")).toBeTruthy();
    act(() => { expect(consumeBackIntercept()).toBe(true); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.getByRole("searchbox", { name: "Search posts" })).toHaveProperty("value", "wallet");
  });
  it("does not treat a shared radius link as location permission or a coordinate", async () => {
    render(tree("/search?near=25&place=Gulshan"));
    await waitFor(() => expect(io.feed).toHaveBeenCalled());
    expect(io.position).not.toHaveBeenCalled(); expect(io.permission).not.toHaveBeenCalled();
    expect(io.feed.mock.calls.at(-1)?.[0].nearLat).toBeUndefined();
    const dialog = await openFilters();
    expect(within(dialog).getByRole("button", { name: "Use my location once" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove nearby filter" })).toBeNull();
  });
  it("queries a rounded explicit center and selected radius together with ordinary filters", async () => {
    render(tree("/search?q=wallet&type=FOUND&category=Electronics&dateFrom=2026-10-01&near=25"));
    const dialog = await openFilters();
    fireEvent.click(within(dialog).getByRole("button", { name: "Use my location once" }));
    await waitFor(() => expect(io.feed).toHaveBeenCalledWith(expect.objectContaining({
      q: "wallet", type: "FOUND", category: "Electronics", dateFrom: "2026-10-01", nearLat: 23.781, nearLng: 90.408, radiusM: 25000,
    }), undefined));
    fireEvent.change(within(dialog).getByLabelText("Distance"), { target: { value: "5" } });
    await waitFor(() => expect(io.feed.mock.calls.at(-1)?.[0].radiusM).toBe(5000));
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    const chip = await screen.findByRole("button", { name: "Remove nearby filter" });
    expect(chip.textContent).toContain("5 km");
    expect(screen.getByTestId("route").textContent).toContain("near=5");
    expect(screen.getByTestId("route").textContent).not.toMatch(/23\.78|90\.40|lat=|lng=/);
    expect(io.position).toHaveBeenCalledWith(expect.objectContaining({ enableHighAccuracy: false }));
    clearFeedCaches(); fireEvent.click(chip);
    await waitFor(() => expect(io.feed.mock.calls.at(-1)?.[0].nearLat).toBeUndefined());
    expect(screen.getByTestId("route").textContent).not.toContain("near=");
  });
  it("leaves ordinary search usable after location denial", async () => {
    io.permission.mockResolvedValue("denied"); render(tree("/search?q=wallet"));
    const dialog = await openFilters();
    fireEvent.click(within(dialog).getByRole("button", { name: "Use my location once" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(io.position).not.toHaveBeenCalled();
    expect(io.feed.mock.calls.at(-1)?.[0].nearLat).toBeUndefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.getByRole("searchbox", { name: "Search posts" })).toHaveProperty("value", "wallet");
  });
  it("rejects impossible provider coordinates instead of sending a nearby scope", async () => {
    io.position.mockResolvedValue({ latitude: 91, longitude: 90, accuracyMeters: 80 });
    render(tree()); const dialog = await openFilters();
    fireEvent.click(within(dialog).getByRole("button", { name: "Use my location once" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(io.feed.mock.calls.at(-1)?.[0].nearLat).toBeUndefined();
    expect(getNearbySession().center).toBeNull();
  });
  it("ignores a late account-A fix after switching to account B", async () => {
    let resolve!: (position: { latitude: number; longitude: number; accuracyMeters: number }) => void;
    io.position.mockReturnValue(new Promise(yes => { resolve = yes; }));
    const page = render(tree()); const dialog = await openFilters();
    fireEvent.click(within(dialog).getByRole("button", { name: "Use my location once" }));
    await waitFor(() => expect(io.position).toHaveBeenCalled());
    io.user = { id: "search-b" }; page.rerender(tree());
    await act(async () => resolve({ latitude: 23.78, longitude: 90.4, accuracyMeters: 80 }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(io.feed.mock.calls.at(-1)?.[0].nearLat).toBeUndefined();
    expect(getNearbySession().center).toBeNull();
  });
  it("clears nearby and all other filters without deleting the report or people queries", async () => {
    render(tree("/search?q=wallet&people=reader&type=LOST&place=Gulshan"));
    const dialog = await openFilters();
    fireEvent.click(within(dialog).getByRole("button", { name: "Use my location once" }));
    await waitFor(() => expect(io.feed.mock.calls.at(-1)?.[0].nearLat).toBe(23.781));
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear all filters" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getByTestId("route").textContent).toBe("/search?q=wallet&people=reader"));
    expect(io.feed.mock.calls.at(-1)?.[0].nearLat).toBeUndefined();
  });
});
