// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchFeedMock, tabTapState, nlExtractLiveMock, nlHelperStateMock } = vi.hoisted(() => ({
  fetchFeedMock: vi.fn(),
  tabTapState: { tapCount: 0 },
  nlExtractLiveMock: vi.fn(),
  nlHelperStateMock: vi.fn(),
}));

vi.mock("../services/posts", () => ({ fetchFeed: fetchFeedMock }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "u1", username: "tester" } }) }));
vi.mock("../components/TabTap", () => ({ useTabTap: () => tabTapState }));
vi.mock("../services/liveNarrowTasks", () => ({
  nlExtractLive: nlExtractLiveMock,
  nlHelperState: nlHelperStateMock,
}));

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
    nlExtractLiveMock.mockReset();
    nlExtractLiveMock.mockResolvedValue({});
    nlHelperStateMock.mockReset();
    // Default: the on-device helper is set up, so an empty patch really does
    // mean "nothing confident". Tests for the other two states opt in.
    nlHelperStateMock.mockResolvedValue("ready");
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

  it("scrolls to top smoothly on tab tap", async () => {
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
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
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });

  it("scrolls to top instantly on tab tap under reduced motion", async () => {
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo as unknown as typeof HTMLElement.prototype.scrollTo;
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
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
        expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" }),
      );
    } finally {
      window.matchMedia = originalMatchMedia;
      HTMLElement.prototype.scrollTo = originalScrollTo;
    }
  });

  it("clear button appears while typing and clears the query, URL param, and feed filter", async () => {
    renderSearch();
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Search posts"), { target: { value: "phone" } });
    await waitFor(
      () => expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ q: "phone" }), undefined),
      { timeout: 3000 },
    );
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("q=phone"));
    expect(screen.getByRole("button", { name: "Clear search" })).toBeTruthy();

    fetchFeedMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect((screen.getByLabelText("Search posts") as HTMLInputElement).value).toBe("");
    // Clearing restores the cached unfiltered feed instead of refetching:
    // the URL param drops and no network call fires.
    await waitFor(() => expect(screen.getByTestId("location").textContent).not.toContain("q="));
    expect(fetchFeedMock).not.toHaveBeenCalled();
  });

  it("cancel collapses the active field back to its compact state", async () => {
    renderSearch();
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Search posts"), { target: { value: "phone" } });
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByLabelText("Search posts") as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  describe("NL smart filters", () => {
    function renderWithNl(nlExtract?: (input: string) => Promise<Record<string, string>>) {
      return render(
        <MemoryRouter initialEntries={["/search"]}>
          <SearchScreen nlExtract={nlExtract as never} />
          <LocationProbe />
        </MemoryRouter>,
      );
    }

    it("applies an extracted patch to the ordinary editable controls", async () => {
      const seen: string[] = [];
      renderWithNl(async (input: string) => {
        seen.push(input);
        return {
          query: "black wallet",
          category: "Bags & Wallets",
          status: "OPEN",
          dateFrom: "2026-09-18",
          dateTo: "2026-09-25",
        };
      });
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), {
        target: { value: "black wallet lost last week" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

      expect(await screen.findByText("Category: Bags & Wallets")).toBeTruthy();
      expect(await screen.findByText("Status: Open")).toBeTruthy();
      expect(await screen.findByRole("button", { name: "Remove start date filter" })).toBeTruthy();
      expect(await screen.findByRole("button", { name: "Remove end date filter" })).toBeTruthy();
      await waitFor(() =>
        expect(fetchFeedMock).toHaveBeenCalledWith(
          expect.objectContaining({
            q: "black wallet",
            category: "Bags & Wallets",
            status: "OPEN",
            dateFrom: "2026-09-18",
            dateTo: "2026-09-25",
          }),
          undefined,
        ),
      );
      expect(seen).toEqual(["black wallet lost last week"]);
      // The query lands in the editable search field, not a hidden filter.
      expect((screen.getByLabelText("Search posts") as HTMLInputElement).value).toBe("black wallet");
    });

    it("leaves filters untouched when nothing confident is extracted", async () => {
      renderWithNl(async () => ({}));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());
      const calls = fetchFeedMock.mock.calls.length;

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "vague" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

      expect(await screen.findByText("No confident filters found — nothing changed.")).toBeTruthy();
      expect(screen.queryByText(/Category:/)).toBeNull();
      // No new feed fetch carries filters: the last call stays unfiltered.
      await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/search"));
      const last = fetchFeedMock.mock.calls[fetchFeedMock.mock.calls.length - 1] as [
        Record<string, unknown>,
      ];
      expect(last[0].category).toBeUndefined();
      expect(last[0].q).toBeUndefined();
      expect(fetchFeedMock.mock.calls.length).toBe(calls);
    });

    it("says the helper is missing instead of 'no confident filters', and offers one way to fix it", async () => {
      nlHelperStateMock.mockResolvedValue("not-set-up");
      renderWithNl(async () => ({}));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "black wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

      // The absence of the helper is a different truth from an unconfident
      // model, so it gets its own sentence — never the "no confident filters"
      // one. The sentence names the action, because the live region is what a
      // screen reader hears and the link beside it is a sibling.
      expect(
        await screen.findByText(
          "Smart Search needs the on-device model, which isn't set up on this device yet — open Manage AI models to install it.",
        ),
      ).toBeTruthy();
      expect(screen.queryByText("No confident filters found — nothing changed.")).toBeNull();

      // Exactly one action in the note row, and it goes to the single download
      // owner. Counting the row's own anchors is the assertion; the row could
      // otherwise carry a second affordance nobody meant to add.
      const noteRow = screen.getByTestId("smart-search-note-row");
      expect(noteRow.querySelectorAll("a")).toHaveLength(1);
      const manageModels = screen.getByTestId("smart-search-manage-models");
      expect(manageModels.getAttribute("href")).toBe("/settings/ai/models");
      expect(manageModels.textContent).toBe("Manage AI models");

      fireEvent.click(manageModels);
      await waitFor(() =>
        expect(screen.getByTestId("location").textContent).toBe("/settings/ai/models"),
      );
    });

    it("offers nothing to install when filters were applied and the helper is missing", async () => {
      nlHelperStateMock.mockResolvedValue("not-set-up");
      renderWithNl(async () => ({ query: "black wallet" }));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "black wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

      // Something happened, so there is nothing to explain and no action to
      // offer — the missing-helper sentence is only ever for an empty patch.
      expect(await screen.findByText(/Applied 1 smart filter/)).toBeTruthy();
      expect(screen.queryByTestId("smart-search-manage-models")).toBeNull();
      expect(screen.queryByText(/needs the on-device model/)).toBeNull();
    });

    it("offers nothing to install when a set-up helper applied filters", async () => {
      nlHelperStateMock.mockResolvedValue("ready");
      renderWithNl(async () => ({ query: "black wallet" }));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "black wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

      expect(await screen.findByText(/Applied 1 smart filter/)).toBeTruthy();
      expect(screen.queryByTestId("smart-search-manage-models")).toBeNull();
      expect(screen.queryByText(/needs the on-device model/)).toBeNull();
    });

    it("says on-device AI needs the Android app instead of offering an install that cannot happen", async () => {
      nlHelperStateMock.mockResolvedValue("unsupported-platform");
      renderWithNl(async () => ({}));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "black wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

      // The canonical Android-required line, not a promise of a future install.
      expect(
        await screen.findByText("On-device AI requires the Android app."),
      ).toBeTruthy();
      expect(screen.queryByText(/isn't set up on this device yet/)).toBeNull();
      expect(screen.getByTestId("smart-search-note-row").querySelectorAll("a")).toHaveLength(0);
      expect(screen.queryByTestId("smart-search-manage-models")).toBeNull();
    });

    it("says the device cannot run it instead of offering an install that cannot help", async () => {
      nlHelperStateMock.mockResolvedValue("unsupported-device");
      renderWithNl(async () => ({}));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "black wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

      // The canonical device-incompatible line, and no action: installing is
      // not something the reader could do (REVIEW-CF040-RESIDUAL-R2 N1).
      expect(await screen.findByText("Unavailable on this device.")).toBeTruthy();
      expect(screen.queryByText(/isn't set up on this device yet/)).toBeNull();
      expect(screen.getByTestId("smart-search-note-row").querySelectorAll("a")).toHaveLength(0);
    });

    it("makes no claim about the device when the state cannot be determined", async () => {
      nlHelperStateMock.mockResolvedValue("unknown");
      renderWithNl(async () => ({}));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "black wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

      // `unknown` is the honest fallback: the ordinary sentence, no install
      // offer, and nothing asserted about the helper's absence.
      expect(await screen.findByText("No confident filters found — nothing changed.")).toBeTruthy();
      expect(screen.queryByText(/needs the on-device model/)).toBeNull();
      expect(screen.queryByTestId("smart-search-manage-models")).toBeNull();
    });

    it("reports failure without changing filters", async () => {
      renderWithNl(async () => {
        throw new Error("boom");
      });
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

      expect(await screen.findByText("Smart search failed — nothing changed.")).toBeTruthy();
      expect((screen.getByLabelText("Search posts") as HTMLInputElement).value).toBe("");
    });

    it("removing a date chip drops the filter", async () => {
      renderWithNl(async () => ({ dateFrom: "2026-09-18", dateTo: "2026-09-25" }));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "last week" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));
      expect(await screen.findByRole("button", { name: "Remove start date filter" })).toBeTruthy();

      fetchFeedMock.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Remove start date filter" }));
      await waitFor(() =>
        expect(screen.getByTestId("location").textContent).not.toContain("dateFrom="),
      );
      expect(screen.queryByRole("button", { name: "Remove start date filter" })).toBeNull();
      // The end-date chip remains editable.
      expect(screen.getByRole("button", { name: "Remove end date filter" })).toBeTruthy();
    });

    it("disables smart filters when no extractor is wired", async () => {
      render(
        <MemoryRouter initialEntries={["/search"]}>
          <SearchScreen nlExtract={undefined} />
          <LocationProbe />
        </MemoryRouter>,
      );
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());
      const button = screen.getByRole("button", { name: "Smart search" });
      expect(button.getAttribute("disabled")).not.toBeNull();
      expect(button.getAttribute("title")).toBe("Smart search unavailable");
    });

    it("defaults a bare mount to the live transport", async () => {
      nlExtractLiveMock.mockReset();
      nlExtractLiveMock.mockResolvedValue({ query: "black wallet" });
      renderSearch();
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      const button = screen.getByRole("button", { name: "Smart search" });
      expect(button.getAttribute("title")).toBe("Apply smart filters");

      fireEvent.change(screen.getByLabelText("Describe your search"), {
        target: { value: "black wallet lost last week" },
      });
      expect(button.getAttribute("disabled")).toBeNull();
      fireEvent.click(button);

      await waitFor(() =>
        expect(nlExtractLiveMock).toHaveBeenCalledWith("black wallet lost last week"),
      );
      expect((screen.getByLabelText("Search posts") as HTMLInputElement).value).toBe("black wallet");
    });

    it("an explicit extractor still wins over the live default", async () => {
      nlExtractLiveMock.mockReset();
      renderWithNl(async () => ({ query: "explicit" }));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), {
        target: { value: "explicit query" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

      await waitFor(() =>
        expect((screen.getByLabelText("Search posts") as HTMLInputElement).value).toBe("explicit"),
      );
      expect(nlExtractLiveMock).not.toHaveBeenCalled();
    });
  });

  it("gives the toolbar separation once the results scroll", async () => {
    const { container } = renderSearch();
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());
    expect(screen.getByTestId("search-toolbar").className).not.toContain("shadow-sm");

    const scroller = container.querySelector(".overflow-y-auto");
    expect(scroller).toBeTruthy();
    (scroller as HTMLElement).scrollTop = 100;
    fireEvent.scroll(scroller as HTMLElement);

    await waitFor(() => expect(screen.getByTestId("search-toolbar").className).toContain("shadow-sm"));
  });
});
