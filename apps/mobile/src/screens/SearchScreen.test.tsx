// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchFeedMock, tabTapState } = vi.hoisted(() => ({
  fetchFeedMock: vi.fn(),
  tabTapState: { tapCount: 0 },
}));

vi.mock("../services/posts", () => ({ fetchFeed: fetchFeedMock }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "tester" } }) }));
vi.mock("../components/TabTap", () => ({ useTabTap: () => tabTapState }));

import { SearchScreen } from "./SearchScreen";
import { clearFeedCaches } from "../hooks/feedCache";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{`${loc.pathname}${loc.search}`}</div>;
}

function renderSearch(entry = "/search") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <SearchScreen />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("SearchScreen URL filters", () => {
  beforeEach(() => {
    fetchFeedMock.mockReset();
    tabTapState.tapCount = 0;
    clearFeedCaches();
    fetchFeedMock.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
  });

  afterEach(() => {
    cleanup();
    clearFeedCaches();
  });

  it("restores every filter from the URL on mount", async () => {
    renderSearch("/search?type=FOUND&category=Electronics&status=OPEN&sort=oldest&q=phone");
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "FOUND",
          category: "Electronics",
          status: "OPEN",
          sort: "oldest",
          q: "phone",
        }),
        undefined,
      ),
    );
    expect(screen.getByRole("radio", { name: "Found" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Search posts") as HTMLInputElement).value).toBe("phone");
  });

  it("degrades unknown deep-linked values to empty", async () => {
    renderSearch("/search?category=Bogus&status=Bogus");
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());
    const [filters] = fetchFeedMock.mock.calls[0] as [Record<string, unknown>];
    expect(filters.category).toBeUndefined();
    expect(filters.status).toBeUndefined();
  });

  it("writes filter edits back to the URL", async () => {
    renderSearch();
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("radio", { name: "Found" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/search?type=FOUND"));
  });

  it("scrolls to top smoothly on tab tap even under reduced motion", async () => {
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    try {
      const { rerender } = renderSearch();
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());
      expect(scrollTo).not.toHaveBeenCalled();
      tabTapState.tapCount = 1;
      rerender(
        <MemoryRouter initialEntries={["/search"]}>
          <SearchScreen />
          <LocationProbe />
        </MemoryRouter>,
      );
      await waitFor(() =>
        expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" }),
      );
    } finally {
      window.matchMedia = originalMatchMedia;
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });
});
