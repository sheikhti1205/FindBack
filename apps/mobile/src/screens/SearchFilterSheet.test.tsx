// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchFeedMock } = vi.hoisted(() => ({ fetchFeedMock: vi.fn() }));

vi.mock("../services/posts", () => ({ fetchFeed: fetchFeedMock }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "tester" } }) }));
vi.mock("../components/TabTap", () => ({ useTabTap: () => ({ tapCount: 0 }) }));

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

describe("SearchScreen filter sheet (G14)", () => {
  beforeEach(() => {
    fetchFeedMock.mockReset();
    clearFeedCaches();
    fetchFeedMock.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
  });

  afterEach(() => {
    cleanup();
    clearFeedCaches();
  });

  it("keeps query + type visible while advanced filters live in a sheet", async () => {
    renderSearch();
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

    // Visible row retained.
    expect(screen.getByLabelText("Search posts")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "All" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Lost" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Found" })).toBeTruthy();

    // Advanced filters are NOT on the visible row anymore.
    expect(screen.queryByLabelText("Category")).toBeNull();
    expect(screen.queryByLabelText("Status")).toBeNull();
    expect(screen.queryByLabelText("Sort")).toBeNull();

    // A Filters launcher opens the sheet.
    expect(screen.getByRole("button", { name: /filters/i })).toBeTruthy();
  });

  it("sheet edit round-trips to a removable chip + the URL", async () => {
    renderSearch();
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /^filters/i }));
    const category = await screen.findByLabelText("Category");
    fireEvent.change(category, { target: { value: "Electronics" } });

    // Chip appears; URL carries the filter (existing :18-35 semantics).
    expect(await screen.findByRole("button", { name: /remove category filter/i })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain("category=Electronics"),
    );
    await waitFor(() =>
      expect(fetchFeedMock).toHaveBeenCalledWith(
        expect.objectContaining({ category: "Electronics" }),
        undefined,
      ),
    );

    // Removing the chip clears the URL param (filterability preserved).
    fireEvent.click(screen.getByRole("button", { name: /remove category filter/i }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).not.toContain("category="),
    );
    expect(screen.queryByRole("button", { name: /remove category filter/i })).toBeNull();
  });

  it("clear-all removes every advanced filter and chip", async () => {
    renderSearch("/search?type=FOUND&category=Electronics&status=OPEN&sort=oldest&q=phone");
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

    expect(await screen.findByRole("button", { name: /remove category filter/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove status filter/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove sort filter/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /clear all filters/i }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/search?type=FOUND&q=phone"),
    );
    expect(screen.queryByRole("button", { name: /remove category filter/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove status filter/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove sort filter/i })).toBeNull();
  });

  it("deep-linked advanced filters restore chips without opening the sheet", async () => {
    renderSearch("/search?category=Electronics&status=OPEN&sort=oldest");
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

    // Chips render from the URL alone.
    expect(await screen.findByRole("button", { name: /remove category filter/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove status filter/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove sort filter/i })).toBeTruthy();

    // The sheet still reflects the deep-linked values when opened.
    fireEvent.click(screen.getByRole("button", { name: /^filters/i }));
    expect((await screen.findByLabelText("Category") as HTMLSelectElement).value).toBe("Electronics");
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("OPEN");
    expect((screen.getByLabelText("Sort") as HTMLSelectElement).value).toBe("oldest");
  });
});
