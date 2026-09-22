// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchFeedMock } = vi.hoisted(() => ({ fetchFeedMock: vi.fn() }));

vi.mock("../posts", () => ({ fetchFeed: fetchFeedMock }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "tester" } }) }));
vi.mock("../../components/TabTap", () => ({ useTabTap: () => ({ tapCount: 0 }) }));

import { SearchScreen } from "../../screens/SearchScreen";
import { clearFeedCaches } from "../../hooks/feedCache";
import {
  mapAssistantSearchFilters,
  navigateToAssistantSearch,
} from "./searchFilterMapping";

function renderSearchAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/search" element={<SearchScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderNavigatingHandoff(fields: Parameters<typeof navigateToAssistantSearch>[1]) {
  function Handoff() {
    const navigate = useNavigate();
    return (
      <button type="button" data-testid="go" onClick={() => navigateToAssistantSearch(navigate, fields)}>
        Go
      </button>
    );
  }
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<Handoff />} />
        <Route path="/search" element={<SearchScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("mapAssistantSearchFilters", () => {
  it("passes the query through as q", () => {
    const target = mapAssistantSearchFilters({ query: "red backpack" });
    expect(target.filters.q).toBe("red backpack");
    expect(target.path).toBe("/search?q=red+backpack");
    expect(target.dropped).toEqual([]);
  });

  it("matches a supported category with canonical casing", () => {
    const target = mapAssistantSearchFilters({ query: "phone", category: "electronics" });
    expect(target.filters.category).toBe("Electronics");
    expect(target.path).toContain("category=Electronics");
    expect(target.dropped).toEqual([]);
  });

  it("drops an unsupported category instead of calling with it", () => {
    const target = mapAssistantSearchFilters({ query: "phone", category: "Spaceship" });
    expect(target.filters.category).toBeUndefined();
    expect(target.path).not.toContain("category=");
    expect(target.dropped).toEqual(["category"]);
  });

  it("matches a supported status case-insensitively", () => {
    const target = mapAssistantSearchFilters({ query: "keys", status: "open" });
    expect(target.filters.status).toBe("OPEN");
    expect(target.filters.type).toBeUndefined();
    expect(target.path).toContain("status=OPEN");
    expect(target.dropped).toEqual([]);
  });

  it("maps lost/found status text to the supported type filter", () => {
    const target = mapAssistantSearchFilters({ query: "wallet", status: "lost" });
    expect(target.filters.type).toBe("LOST");
    expect(target.filters.status).toBeUndefined();
    expect(target.path).toContain("type=LOST");
    expect(target.dropped).toEqual([]);
  });

  it("drops an unsupported status instead of calling with it", () => {
    const target = mapAssistantSearchFilters({ query: "keys", status: "urgent" });
    expect(target.filters.status).toBeUndefined();
    expect(target.filters.type).toBeUndefined();
    expect(target.dropped).toEqual(["status"]);
  });

  it("drops dateRangeText: the screen has no date filter", () => {
    const target = mapAssistantSearchFilters({ query: "umbrella", dateRangeText: "last week" });
    expect(target.filters.q).toBe("umbrella");
    expect(target.path).toBe("/search?q=umbrella");
    expect(target.dropped).toEqual(["dateRangeText"]);
  });

  it("builds the bare search route when every slot is unsupported", () => {
    const target = mapAssistantSearchFilters({ dateRangeText: "yesterday" });
    expect(target.path).toBe("/search");
    expect(target.filters).toEqual({
      type: undefined,
      q: undefined,
      category: undefined,
      status: undefined,
    });
    expect(target.dropped).toEqual(["dateRangeText"]);
  });
});

describe("navigateToAssistantSearch", () => {
  beforeEach(() => {
    fetchFeedMock.mockReset();
    clearFeedCaches();
    fetchFeedMock.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
  });

  afterEach(() => {
    cleanup();
    clearFeedCaches();
  });

  it("navigates with only supported params", () => {
    const navigate = vi.fn();
    const target = navigateToAssistantSearch(navigate, {
      query: "keys",
      category: "Keys",
      status: "open",
      dateRangeText: "last week",
    });
    expect(navigate).toHaveBeenCalledWith(target.path);
    expect(target.path).toBe("/search?q=keys&category=Keys&status=OPEN");
    expect(target.dropped).toEqual(["dateRangeText"]);
  });

  it("lands in the ordinary search flow, which executes the mapped filters", async () => {
    renderNavigatingHandoff({ query: "keys", category: "Keys", status: "open" });
    screen.getByTestId("go").click();
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "",
          category: "Keys",
          status: "OPEN",
          sort: "newest",
          q: "keys",
        }),
        undefined,
      ),
    );
    expect(await screen.findByText("Search & filter")).toBeTruthy();
  });

  it("renders the bare search when the handoff carries no supported filter", async () => {
    renderSearchAt(mapAssistantSearchFilters({ dateRangeText: "last week" }).path);
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());
    const [filters] = fetchFeedMock.mock.calls[0] as [Record<string, unknown>];
    expect(filters.q).toBeUndefined();
    expect(filters.category).toBeUndefined();
    expect(filters.status).toBeUndefined();
  });
});
