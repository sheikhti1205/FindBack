// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchFeedMock, handlers, onRealtimeMock, tabTapState, adapterFactoryMock, adapterState, authState } =
  vi.hoisted(() => {
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const adapterState = {
      permission: "granted" as "granted" | "prompt" | "denied" | "unknown",
      services: null as boolean | null,
      position: { latitude: 12.34567, longitude: 77.65432, accuracyMeters: 40 },
      calls: 0,
    };
    const adapterFactoryMock = vi.fn(() => ({
      getCurrentPosition: async () => {
        adapterState.calls += 1;
        return { ...adapterState.position };
      },
      getPermission: async () => adapterState.permission,
      servicesEnabled: async () => adapterState.services,
    }));
    const authState: { user: { id: string; username: string } | null } = {
      user: { id: "u1", username: "tester" },
    };
    return {
      fetchFeedMock: vi.fn(),
      handlers,
      tabTapState: { tapCount: 0 },
      onRealtimeMock: vi.fn((event: string, handler: (payload: unknown) => void) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
        return () => handlers.get(event)?.delete(handler);
      }),
      adapterFactoryMock,
      adapterState,
      authState,
    };
  });

vi.mock("../services/posts", () => ({ fetchFeed: fetchFeedMock }));
vi.mock("../services/realtime", () => ({ onRealtime: onRealtimeMock }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: authState.user }) }));
vi.mock("../components/TabTap", () => ({ useTabTap: () => tabTapState }));
vi.mock("../services/locationAdapter", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/locationAdapter")>();
  return { ...orig, createProductionLocationAdapter: adapterFactoryMock };
});
vi.mock("../components/MapPickerSheet", () => ({
  MapPickerSheet: ({
    open,
    onClose,
    onConfirm,
  }: {
    open: boolean;
    onClose: () => void;
    onConfirm: (v: { label: string; latitude: number | null; longitude: number | null }) => void;
  }) =>
    open ? (
      <div data-testid="map-picker">
        <button onClick={() => onConfirm({ label: "Mock Place", latitude: 13.11111, longitude: 78.22222 })}>
          Confirm pin
        </button>
        <button onClick={() => onConfirm({ label: "Typed only", latitude: null, longitude: null })}>
          Confirm typed-only
        </button>
        <button onClick={onClose}>Close picker</button>
      </div>
    ) : null,
}));
vi.mock("../components/PostList", () => ({
  PostList: ({ items }: { items: Array<{ id: string }> }) => (
    <ul data-testid="posts">
      {items.map((i) => (
        <li key={i.id}>{i.id}</li>
      ))}
    </ul>
  ),
}));

import { Home } from "./Home";
import { clearFeedCaches } from "../hooks/feedCache";
import { clearNearbySession, recentCutoffDate } from "../services/nearby";
import { resetBackInterceptors } from "../components/backNavigation";

function emit(event: string, payload: unknown) {
  for (const handler of handlers.get(event) ?? []) handler(payload);
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{`${loc.pathname}${loc.search}`}</div>;
}

function renderHome(entry = "/") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Home />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function nearbyToggle() {
  return screen.getByRole("button", { name: /^nearby/i });
}

async function enableNearby() {
  fireEvent.click(nearbyToggle());
  await waitFor(() =>
    expect(fetchFeedMock).toHaveBeenCalledWith(
      expect.objectContaining({ nearLat: 12.346, nearLng: 77.654, radiusM: 10_000 }),
      undefined,
    ),
  );
}

describe("Home nearby discovery (UXN-1)", () => {
  beforeEach(() => {
    fetchFeedMock.mockReset();
    onRealtimeMock.mockClear();
    adapterFactoryMock.mockClear();
    handlers.clear();
    tabTapState.tapCount = 0;
    authState.user = { id: "u1", username: "tester" };
    adapterState.permission = "granted";
    adapterState.services = null;
    adapterState.position = { latitude: 12.34567, longitude: 77.65432, accuracyMeters: 40 };
    adapterState.calls = 0;
    clearFeedCaches();
    clearNearbySession();
    fetchFeedMock.mockResolvedValue({
      items: ["a", "b", "c"].map((id) => ({ id, title: id })),
      nextCursor: null,
      total: 3,
    });
  });

  afterEach(() => {
    cleanup();
    clearFeedCaches();
    clearNearbySession();
    resetBackInterceptors();
  });

  it("never prompts for location on mount — only after tapping Nearby", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    expect(adapterFactoryMock).not.toHaveBeenCalled();
    expect(nearbyToggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("combines Lost + Nearby without changing the type filter", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    fireEvent.click(screen.getByRole("radio", { name: "Lost" }));
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ type: "LOST" }), undefined),
    );
    await enableNearby();
    expect(fetchFeedMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "LOST", nearLat: 12.346, nearLng: 77.654, radiusM: 10_000 }),
      undefined,
    );
    expect(screen.getByRole("radio", { name: "Lost" }).getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("type=LOST"));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("near=10"));
  });

  it("combines Found + Nearby", async () => {
    renderHome("/?type=FOUND");
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ type: "FOUND" }), undefined),
    );
    await enableNearby();
    expect(fetchFeedMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "FOUND", nearLat: 12.346, nearLng: 77.654, radiusM: 10_000 }),
      undefined,
    );
  });

  it("combines All + Nearby and keeps All selected", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    await enableNearby();
    expect(fetchFeedMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "", nearLat: 12.346, nearLng: 77.654, radiusM: 10_000 }),
      undefined,
    );
    expect(screen.getByRole("radio", { name: "All" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("location").textContent).not.toContain("type=");
  });

  it("never puts coordinates in the URL — only `near=<km>`", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    await enableNearby();
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("near=10"));
    const search = screen.getByTestId("location").textContent ?? "";
    expect(search).not.toContain("12.346");
    expect(search).not.toContain("77.654");
    expect(search).not.toMatch(/lat|lng/i);
  });

  it("shows Nearby · 10 km by default with configurable 2/5/10/25/50 radii", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    await enableNearby();
    expect(await screen.findByRole("button", { name: /nearby · 10 km/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /nearby · 10 km/i }));
    for (const km of ["2 km", "5 km", "10 km", "25 km", "50 km"]) {
      expect(await screen.findByRole("radio", { name: km })).toBeTruthy();
    }
    expect(
      await screen.findByText(
        "Nearby uses reports with a map pin. Reports with only a typed place name are not included.",
      ),
    ).toBeTruthy();
  });

  it("separates the radius in fetch + URL (radius cache separation)", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    await enableNearby();
    fireEvent.click(screen.getByRole("button", { name: /nearby · 10 km/i }));
    fireEvent.click(await screen.findByRole("radio", { name: "25 km" }));
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ radiusM: 25_000 }), undefined),
    );
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("near=25"));
    expect(await screen.findByRole("button", { name: /nearby · 25 km/i })).toBeTruthy();
  });

  it("turning Nearby off clears the radius from the feed and URL", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    await enableNearby();
    // Disabling restores the cached unfiltered feed without refetching.
    fetchFeedMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /nearby · 10 km/i }));
    fireEvent.click(await screen.findByRole("button", { name: /turn off nearby/i }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).not.toContain("near="));
    expect(nearbyToggle().getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("a")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchFeedMock).not.toHaveBeenCalled();
  });

  it("denied permission keeps Nearby off and offers Choose area on map", async () => {
    adapterState.permission = "denied";
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    fireEvent.click(nearbyToggle());
    expect(await screen.findByText(/location access is off for findback/i)).toBeTruthy();
    expect(nearbyToggle().getAttribute("aria-pressed")).toBe("false");
    expect(fetchFeedMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ radiusM: expect.anything() }),
      undefined,
    );
    fireEvent.click(screen.getByRole("button", { name: /choose area on map/i }));
    expect(await screen.findByTestId("map-picker")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm pin" }));
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(
        expect.objectContaining({ nearLat: 13.111, nearLng: 78.222, radiusM: 10_000 }),
        undefined,
      ),
    );
    expect(await screen.findByRole("button", { name: /nearby · 10 km/i })).toBeTruthy();
  });

  it("device-location-off uses recovery copy and still allows manual fallback", async () => {
    adapterState.services = false;
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    fireEvent.click(nearbyToggle());
    expect(await screen.findByText(/device location is off/i)).toBeTruthy();
    expect(nearbyToggle().getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /choose area on map/i })).toBeTruthy();
  });

  it("a typed-only manual choice cannot activate Nearby (text-only excluded)", async () => {
    adapterState.permission = "denied";
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    fireEvent.click(nearbyToggle());
    fireEvent.click(await screen.findByRole("button", { name: /choose area on map/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm typed-only" }));
    await waitFor(() =>
      expect(screen.getByText(/needs a map pin|typed place name/i)).toBeTruthy(),
    );
    expect(nearbyToggle().getAttribute("aria-pressed")).toBe("false");
    expect(fetchFeedMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ radiusM: expect.anything() }),
      undefined,
    );
  });

  it("clears the session center on account switch so the next tap re-prompts", async () => {
    const { rerender } = renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    await enableNearby();
    expect(adapterState.calls).toBe(1);

    authState.user = { id: "u2", username: "other" };
    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <Home />
        <LocationProbe />
      </MemoryRouter>,
    );
    await waitFor(() => expect(nearbyToggle().getAttribute("aria-pressed")).toBe("false"));
    expect(screen.getByTestId("location").textContent).not.toContain("near=");

    fireEvent.click(nearbyToggle());
    await waitFor(() => expect(adapterState.calls).toBe(2));
  });

  it("maps Recent to the last 7 days via dateFrom and restores it from the URL", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^recent$/i }));
    const expected = recentCutoffDate();
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ dateFrom: expected }), undefined),
    );
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("recent=1"));
    fireEvent.click(screen.getByRole("button", { name: /^recent$/i }));
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ dateFrom: undefined }), undefined),
    );
  });

  it("maps Open to status OPEN, replacing an advanced status and clearing only OPEN", async () => {
    renderHome("/?status=MATCHED");
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ status: "MATCHED" }), undefined),
    );
    fireEvent.click(screen.getByRole("button", { name: /^open$/i }));
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ status: "OPEN" }), undefined),
    );
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("status=OPEN"));
    fireEvent.click(screen.getByRole("button", { name: /^open$/i }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).not.toContain("status="));
  });

  it("combines All + Open + Recent", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^open$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^recent$/i }));
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "", status: "OPEN", dateFrom: recentCutoffDate() }),
        undefined,
      ),
    );
  });

  it("shows generic Updates (never N new posts) for realtime while Nearby is active", async () => {
    const { container } = renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    await enableNearby();
    fetchFeedMock.mockClear();

    const scroller = container.querySelector(".overflow-y-auto");
    expect(scroller).toBeTruthy();
    (scroller as HTMLElement).scrollTop = 100;

    act(() =>
      emit("feed:changed", { change: "INSERT", op: "INSERT", postId: "n1", postType: "LOST" }),
    );
    expect(await screen.findByRole("button", { name: "Updates — tap to refresh" })).toBeTruthy();
    expect(screen.queryByText(/new post/i)).toBeNull();
    expect(fetchFeedMock).not.toHaveBeenCalled();
  });

  it("refreshes at top for realtime while Nearby is active", async () => {
    renderHome();
    await waitFor(() => expect(screen.getByText("b")).toBeTruthy());
    await enableNearby();
    fetchFeedMock.mockClear();

    act(() =>
      emit("feed:changed", { change: "INSERT", op: "INSERT", postId: "n1", postType: "LOST" }),
    );
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/new post/i)).toBeNull();
  });
});
