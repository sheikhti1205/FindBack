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
import { NEEDLE_DESCRIPTOR } from "../services/ai/modelDescriptors";
import type { LocalIntelligenceService } from "../services/ai/localIntelligenceView";
import type { OfflineModelStatus } from "../services/ai/offlineModelManager";

function helperService() {
  // Only the platform boundary is faked. The shared lifecycle row, readiness
  // hook, size derivation, compatibility gate and error copy run unchanged.
  return {
    android: true, ready: Promise.resolve(),
    registry: { descriptorFor: () => NEEDLE_DESCRIPTOR },
    manager: {
      statusOf: (() => undefined) as (modelId: string) => OfflineModelStatus | undefined,
    },
    subscribe: () => () => {}, snapshot: () => 0,
    ensureCompatibility: async () => {}, compatibility: () => ({ compatible: true }),
    notice: () => null, busy: () => false,
    download: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), verify: vi.fn(), remove: vi.fn(),
  };
}

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

  it("keeps the filter column a bounded scroll region so nothing in it is clipped away", () => {
    // The app's viewport never scrolls: the route owns the scroller. At 320 dp
    // with 200 % text the filter column is taller than the screen, so it must
    // be BOUNDED and scrollable — otherwise the Filters trigger and the
    // offer's buttons are cut off below the fold and unreachable by touch.
    renderSearch("/search");
    const column = screen.getByRole("region", { name: "Search filters" });
    expect(column.className).toContain("overflow-y-auto");
    expect(column.className).toContain("max-h-");
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

  it("offers ordinary date controls without calling Smart Search", async () => {
    renderSearch();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.change(await screen.findByLabelText("From date"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-10-21" } });
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ dateFrom: "2026-10-01", dateTo: "2026-10-21" }), undefined));
    expect(nlExtractLiveMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("location").textContent).toContain("dateFrom=2026-10-01");
  });

  it("restores date inputs and clears all filters together without losing the query", async () => {
    renderSearch("/search?q=wallet&category=Electronics&dateFrom=2026-10-01&dateTo=2026-10-21");
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    expect((await screen.findByLabelText("From date") as HTMLInputElement).value).toBe("2026-10-01");
    expect((screen.getByLabelText("To date") as HTMLInputElement).value).toBe("2026-10-21");
    const dialog = screen.getByRole("dialog");
    fireEvent.click(Array.from(dialog.querySelectorAll("button")).find(button => button.textContent === "Clear all filters")!);
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/search?q=wallet"));
    expect((screen.getByLabelText("From date") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("To date") as HTMLInputElement).value).toBe("");
  });

  it("does not send impossible or reversed date bounds to the feed", async () => {
    // A REVERSED range is meaningless as a whole, so neither bound is sent.
    renderSearch("/search?dateFrom=2026-10-21&dateTo=2026-01-01");
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());
    expect(fetchFeedMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ dateFrom: undefined, dateTo: undefined }));
    expect(screen.getByRole("alert").textContent).toMatch(/valid date range/i);
  });

  it("shows the entered range in the sheet so a reversed one can be fixed", async () => {
    // The feed takes no date from a reversed range, but the reader must still
    // SEE what they typed — otherwise the mistake vanishes silently.
    renderSearch("/search?dateFrom=2026-10-21&dateTo=2026-01-01");
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    expect((await screen.findByLabelText("From date") as HTMLInputElement).value).toBe("2026-10-21");
    expect((screen.getByLabelText("To date") as HTMLInputElement).value).toBe("2026-01-01");
    // No date chip claims a filter that is not applied.
    expect(screen.queryByRole("button", { name: /remove start date filter/i })).toBeNull();
  });

  it("keeps the valid bound when only the other day is impossible", async () => {
    // One impossible day must not throw away the other, VALID one: the
    // reader asked for a range and half of it is usable.
    renderSearch("/search?dateFrom=2026-02-30&dateTo=2026-10-21");
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());
    expect(fetchFeedMock.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ dateFrom: undefined, dateTo: "2026-10-21" }),
    );
    // The sheet shows what is really applied, so the impossible day is not
    // presented as a filter the reader has on.
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    expect((await screen.findByLabelText("From date") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("To date") as HTMLInputElement).value).toBe("2026-10-21");
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
    function renderWithNl(nlExtract?: (input: string) => Promise<Record<string, string>>, helper?: ReturnType<typeof helperService>) {
      return render(
        <MemoryRouter initialEntries={["/search"]}>
          <SearchScreen nlExtract={nlExtract as never} helperService={helper as unknown as LocalIntelligenceService | undefined} />
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

    it("searches the raw phrase when no confident filters are extracted", async () => {
      renderWithNl(async () => ({}));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "vague" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

      expect(await screen.findByText("No extra filters found — searching your words.")).toBeTruthy();
      expect(screen.queryByText(/Category:/)).toBeNull();
      await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/search?q=vague"));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ q: "vague" }), undefined));
      const last = fetchFeedMock.mock.calls[fetchFeedMock.mock.calls.length - 1] as [
        Record<string, unknown>,
      ];
      expect(last[0].category).toBeUndefined();
      expect(last[0].q).toBe("vague");
    });

    it("offers explicit helper setup without leaving ordinary search", async () => {
      nlHelperStateMock.mockResolvedValue("not-set-up");
      const service = helperService();
      renderWithNl(async () => ({}), service);
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "black wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

      expect(
        await screen.findByText(
          "Smart Search needs the local search helper. Searching your words normally.",
        ),
      ).toBeTruthy();
      expect(screen.queryByText("No confident filters found — nothing changed.")).toBeNull();

      fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
      await waitFor(() => expect(screen.queryByRole("button", { name: "Not now" })).toBeNull());
      expect((screen.getByLabelText("Search posts") as HTMLInputElement).value).toBe("black wallet");
      expect(document.activeElement).toBe(screen.getByLabelText("Search posts"));
      // The fallback searched the reader's WORDS in the editable field; it
      // wrote no filter into the URL that the reader never confirmed. The
      // query itself is published after the debounce, so the URL is checked
      // for FILTERS — not snapshotted, which would race the debounce.
      expect(screen.getByTestId("location").textContent).not.toMatch(/category=|status=|sort=|dateFrom=|dateTo=/);
      expect(service.download).not.toHaveBeenCalled();
      // The words really are searched (the feed is asked for them), and the
      // URL still carries no filter.
      await waitFor(() =>
        expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ q: "black wallet" }), undefined),
      );
      await waitFor(() => expect(screen.getByTestId("location").textContent).toMatch(/^\/search\?q=black/));
      expect(screen.getByTestId("location").textContent).not.toMatch(/category=|status=|dateFrom=|dateTo=/);
    });

    it("keeps the offer and its transfer line while a new Smart Search works", async () => {
      // The note comes and goes with every Smart Search. The offer must not go
      // with it: a transfer in flight owns its progress line and its error
      // line, and the reader must be able to see the bytes that move.
      nlHelperStateMock.mockResolvedValue("not-set-up");
      const service = helperService();
      service.manager.statusOf = () => ({
        modelId: NEEDLE_DESCRIPTOR.modelId,
        download: "downloading",
        residency: "unloaded",
        downloadedBytes: 0,
        checksumVerified: false,
        updatedAt: "2026-10-21T00:00:00.000Z",
      });
      let call = 0;
      let answer!: (value: Record<string, string>) => void;
      renderWithNl(() => {
        call += 1;
        if (call === 1) return Promise.resolve({} as Record<string, string>);
        return new Promise<Record<string, string>>(resolve => { answer = resolve; });
      }, service);
      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));
      await screen.findByRole("heading", { name: "Local search helper" });

      // A second Smart Search clears the note while it works.
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));
      await waitFor(() => expect(screen.queryByTestId("smart-search-note-row")).toBeNull());
      // The offer is still there, with its transfer line.
      expect(screen.getByTestId("smart-search-offer-row")).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Local search helper" })).toBeTruthy();
      // And the way out is gone while the bytes move.
      expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
      answer({});
    });

    it.each(["queued", "downloading", "verifying"] as const)(
      "keeps the offer while the transfer is %s",
      async (download) => {
        // The device QUEUES a transfer before it downloads it and VERIFIES the
        // bytes before it calls the model installed: all three states mean
        // "the bytes are still moving".
        nlHelperStateMock.mockResolvedValue("not-set-up");
        const service = helperService();
        service.manager.statusOf = () => ({
          modelId: NEEDLE_DESCRIPTOR.modelId,
          download,
          residency: "unloaded",
          downloadedBytes: 0,
          checksumVerified: false,
          updatedAt: "2026-10-21T00:00:00.000Z",
        });
        renderWithNl(async () => ({}), service);
        fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "wallet" } });
        fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

        await screen.findByRole("heading", { name: "Local search helper" });
        // The way out is gone while the bytes move: dismissing the offer would
        // strand a running transfer with no progress and no error line.
        expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
      },
    );

    it("starts a sized download only after the reader explicitly asks", async () => {
      nlHelperStateMock.mockResolvedValue("not-set-up");
      const service = helperService();
      renderWithNl(async () => ({}), service);
      expect(service.download).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));
      const download = await screen.findByRole("button", { name: "Download · 35.3 MB" });
      expect(service.download).not.toHaveBeenCalled();
      fireEvent.click(download);
      await waitFor(() => expect(service.download).toHaveBeenCalledExactlyOnceWith(NEEDLE_DESCRIPTOR.modelId));
      expect((screen.getByLabelText("Search posts") as HTMLInputElement).value).toBe("wallet");
    });

    it("takes the way out away the moment the reader asks for the download", async () => {
      // The device registers the transfer a TICK after the click. Until it
      // does, the row is still busy — and offering "Not now" in that window
      // would let the reader dismiss a download the device has already
      // started, leaving it with no progress line and no error line.
      nlHelperStateMock.mockResolvedValue("not-set-up");
      const service = helperService();
      service.download.mockImplementation(() => new Promise<void>(() => {}));
      renderWithNl(async () => ({}), service);
      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));
      const download = await screen.findByRole("button", { name: "Download · 35.3 MB" });
      expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();

      fireEvent.click(download);
      await waitFor(() => expect(screen.queryByRole("button", { name: "Not now" })).toBeNull());
      // Nothing else hid it: the device never registered a transfer.
      expect(service.manager.statusOf(NEEDLE_DESCRIPTOR.modelId)).toBeUndefined();
    });

    it("keeps ordinary search usable when the explicit download fails", async () => {
      nlHelperStateMock.mockResolvedValue("not-set-up");
      const service = helperService();
      service.download.mockRejectedValue(new Error("out of space"));
      renderWithNl(async () => ({}), service);
      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));
      fireEvent.click(await screen.findByRole("button", { name: "Download · 35.3 MB" }));
      expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Free some space on this device, then try again.");
      fireEvent.change(screen.getByLabelText("Search posts"), { target: { value: "phone" } });
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ q: "phone" }), undefined));
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
      expect(await screen.findByText("No extra filters found — searching your words.")).toBeTruthy();
      expect(screen.queryByText(/needs the on-device model/)).toBeNull();
      expect(screen.queryByTestId("smart-search-manage-models")).toBeNull();
    });

    it("uses ordinary search when extraction fails", async () => {
      renderWithNl(async () => {
        throw new Error("boom");
      });
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

      expect(await screen.findByText("Smart Search couldn't add filters — searching your words.")).toBeTruthy();
      expect((screen.getByLabelText("Search posts") as HTMLInputElement).value).toBe("wallet");
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ q: "wallet" }), undefined));
    });

    it("does not overwrite newer ordinary edits when extraction answers late", async () => {
      let answer!: (value: Record<string, string>) => void;
      renderWithNl(() => new Promise(resolve => { answer = resolve; }));
      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "old wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));
      fireEvent.change(screen.getByLabelText("Search posts"), { target: { value: "new phone" } });
      answer({ query: "old wallet", category: "Bags & Wallets" });
      await waitFor(() => expect(screen.getByRole("button", { name: "Smart search" }).hasAttribute("disabled")).toBe(false));
      expect((screen.getByLabelText("Search posts") as HTMLInputElement).value).toBe("new phone");
      expect(screen.queryByText("Category: Bags & Wallets")).toBeNull();
    });

    it("keeps the reader's words when a FILTER changes while Smart Search works", async () => {
      // A filter is not a new search. The answer must not be thrown away:
      // the phrase is the reader's, and it is still what they asked for.
      let answer!: (value: Record<string, string>) => void;
      renderWithNl(() => new Promise(resolve => { answer = resolve; }));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "black wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));
      // The reader changes a filter while the answer is on its way.
      fireEvent.click(screen.getByRole("radio", { name: "Found" }));
      answer({ query: "black wallet", category: "Bags & Wallets" });

      expect(
        await screen.findByText(
          "Your filter choices changed while Smart Search worked, so only your words were used.",
        ),
      ).toBeTruthy();
      // The words are searched...
      await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("q=black"));
      await waitFor(() =>
        expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ q: "black wallet" }), undefined),
      );
      // ...and the reader's own filter choice is not overwritten.
      expect(screen.queryByText("Category: Bags & Wallets")).toBeNull();
      expect(screen.getByRole("radio", { name: "Found" }).getAttribute("aria-checked")).toBe("true");
    });

    it("refuses an extracted date that is not a real day", async () => {
      renderWithNl(async () => ({ query: "black wallet", dateFrom: "2026-02-30" }));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "black wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));

      expect(
        await screen.findByText(
          "Smart Search had a date that isn't a real date, so only your words were used.",
        ),
      ).toBeTruthy();
      // The impossible day never reaches the URL...
      expect(screen.getByTestId("location").textContent).not.toContain("dateFrom=");
      // ...and it is not counted as a filter the reader has on.
      expect(screen.queryByRole("button", { name: "Remove start date filter" })).toBeNull();
      await waitFor(() =>
        expect(fetchFeedMock).toHaveBeenCalledWith(expect.objectContaining({ q: "black wallet" }), undefined),
      );
    });

    it("ignores an answer that arrives after the screen is gone", async () => {
      const errors: unknown[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args); });
      let answer!: (value: Record<string, string>) => void;
      const view = renderWithNl(() => new Promise(resolve => { answer = resolve; }));
      await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());

      fireEvent.change(screen.getByLabelText("Describe your search"), { target: { value: "black wallet" } });
      fireEvent.click(screen.getByRole("button", { name: "Smart search" }));
      const callsBeforeUnmount = fetchFeedMock.mock.calls.length;
      view.unmount();
      answer({ query: "black wallet", category: "Bags & Wallets" });
      await new Promise(resolve => setTimeout(resolve, 0));
      spy.mockRestore();

      expect(errors).toEqual([]);
      // A late answer may not drive a search for a screen that is gone.
      expect(fetchFeedMock.mock.calls.length).toBe(callsBeforeUnmount);
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
      await waitFor(() => expect(screen.queryByRole("button", { name: "Remove start date filter" })).toBeNull());
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
    renderSearch();
    await waitFor(() => expect(fetchFeedMock).toHaveBeenCalled());
    expect(screen.getByTestId("search-toolbar").className).not.toContain("shadow-sm");

    const scroller = screen.getByTestId("search-results-scroller");
    expect(scroller).toBeTruthy();
    (scroller as HTMLElement).scrollTop = 100;
    fireEvent.scroll(scroller as HTMLElement);

    await waitFor(() => expect(screen.getByTestId("search-toolbar").className).toContain("shadow-sm"));
  });
});
