// @vitest-environment jsdom
/**
 * The Saved reports screen: it owns NOTHING but the report CONTENT. The saved
 * list itself belongs to the provider, so the screen shows exactly what the
 * save control shows — including an honest empty state, an honest error state,
 * a report that no longer exists labelled instead of crashed, and a footer
 * that says where the saves actually live.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, fetchPostMock, authState } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fetchPostMock: vi.fn(),
  authState: { userId: "u1" as string | null },
}));

vi.mock("../services/supabaseClient", () => ({ getSupabase: () => ({ rpc: rpcMock }) }));
vi.mock("../auth", () => ({
  useAuth: () => ({ user: authState.userId ? { id: authState.userId, username: "alice" } : null }),
}));
vi.mock("../services/posts", () => ({ fetchPost: fetchPostMock }));

import { SavedReports, isDeviceOnlySave } from "./SavedReports";
import { SavePostButton } from "../components/SavePostButton";
import { SavedReportsProvider } from "../hooks/useSavedReports";
import { readSavedReports, writeSavedReport } from "../services/savedReports";
import { ApiError } from "../services/session";

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={["/saved"]}>
      <SavedReportsProvider>
        <SavedReports />
      </SavedReportsProvider>
    </MemoryRouter>,
  );
}

/** The screen next to the control that fills it: they must never disagree. */
function renderScreenWithSave() {
  return render(
    <MemoryRouter initialEntries={["/saved"]}>
      <SavedReportsProvider>
        <SavePostButton postId="p1" title="Lost keys" />
        <SavedReports />
      </SavedReportsProvider>
    </MemoryRouter>,
  );
}

/** The screen alone, re-renderable (the account can change under it). */
function screenTree() {
  return (
    <MemoryRouter initialEntries={["/saved"]}>
      <SavedReportsProvider>
        <SavedReports />
      </SavedReportsProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  rpcMock.mockReset();
  fetchPostMock.mockReset();
  authState.userId = "u1";
  // The account answered and holds nothing.
  rpcMock.mockResolvedValue({ data: { items: [], complete: true }, error: null });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SavedReports", () => {
  it("never claims a save is device-only when the account holds it", () => {
    // The row's note and the screen's footer are two statements about the
    // same thing. A record the account holds may never be called "on this
    // device only", whatever a stale issue says.
    expect(
      isDeviceOnlySave({ onAccount: false, issue: { intent: "save", accountFailed: true } }),
    ).toBe(true);
    expect(
      isDeviceOnlySave({ onAccount: true, issue: { intent: "save", accountFailed: true } }),
    ).toBe(false);
    expect(
      isDeviceOnlySave({ onAccount: false, issue: { intent: "unsave", accountFailed: true } }),
    ).toBe(false);
    expect(isDeviceOnlySave({ onAccount: false, issue: null })).toBe(false);
  });

  it("shows an empty state when nothing is saved", async () => {
    renderScreen();
    expect(await screen.findByText("No saved reports yet")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Saved reports" })).toBeTruthy();
    expect(screen.queryByTestId("saved-reports-list")).toBeNull();
  });

  it("lists a saved report with its title and links into the report", async () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    fetchPostMock.mockResolvedValue({ id: "p1", title: "Lost keys near the park" });
    renderScreen();

    const link = await screen.findByRole("link", { name: /Lost keys near the park/ });
    expect(link.getAttribute("href")).toBe("/posts/p1");
    const list = screen.getByTestId("saved-reports-list");
    expect(within(list).getByText(/^Saved /)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Remove Lost keys near the park/ })).toBeTruthy();
  });

  it("labels a report that no longer exists instead of crashing", async () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    fetchPostMock.mockRejectedValue(new ApiError("Post not found", 404));
    renderScreen();

    expect(await screen.findByText(/No longer available/)).toBeTruthy();
    // The saved title snapshot is still there.
    expect(screen.getByRole("link", { name: /Lost keys/ })).toBeTruthy();
  });

  it("shows an error state when the reports cannot be loaded at all", async () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    fetchPostMock.mockRejectedValue(new ApiError("offline", 400));
    renderScreen();

    expect(await screen.findByText("Couldn't load your saved reports.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("says the saves are on this device when the account does not hold them", async () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    fetchPostMock.mockResolvedValue({ id: "p1", title: "Lost keys" });
    renderScreen();

    await waitFor(() =>
      expect(screen.getByTestId("saved-reports-storage").textContent).toBe(
        "Saved on this device",
      ),
    );
  });

  it("says the saves are on the account when the account holds them", async () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    rpcMock.mockResolvedValue({
      data: { items: [{ post_id: "p1", saved_at: new Date().toISOString() }], complete: true },
      error: null,
    });
    fetchPostMock.mockResolvedValue({ id: "p1", title: "Lost keys" });
    renderScreen();

    await waitFor(() =>
      expect(screen.getByTestId("saved-reports-storage").textContent).toBe(
        "Saved to your account",
      ),
    );
  });

  it("says the saves are on the account after a successful save, without asking again", async () => {
    // The account holds nothing yet, and it confirms every write.
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") return { data: { items: [], complete: true }, error: null };
      return { data: true, error: null };
    });
    fetchPostMock.mockResolvedValue({ id: "p1", title: "Lost keys" });
    renderScreenWithSave();

    fireEvent.click(screen.getByTestId("save-report-button"));

    // The account confirmed the save, so the screen says where the save lives
    // — without asking the account a second time to prove it.
    await waitFor(() =>
      expect(screen.getByTestId("saved-reports-storage").textContent).toBe(
        "Saved to your account",
      ),
    );
    const lists = rpcMock.mock.calls.filter(
      (call) => call[0] === "findback_list_saved_posts_client",
    );
    expect(lists).toHaveLength(1);
  });

  it("removes a saved report from the device", async () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    fetchPostMock.mockResolvedValue({ id: "p1", title: "Lost keys" });
    renderScreen();

    const remove = await screen.findByRole("button", { name: /Remove Lost keys/ });
    remove.click();

    await waitFor(() => expect(screen.queryByTestId("saved-reports-list")).toBeNull());
    expect(await screen.findByText("No saved reports yet")).toBeTruthy();
  });

  it("removes a report that only the account holds, without ever saving it", async () => {
    // The report was saved on another device: the account holds it, this
    // device does not.
    rpcMock.mockResolvedValue({
      data: { items: [{ post_id: "p1", saved_at: new Date().toISOString() }], complete: true },
      error: null,
    });
    fetchPostMock.mockResolvedValue({ id: "p1", title: "Lost keys" });
    renderScreen();

    const remove = await screen.findByRole("button", { name: /Remove Lost keys/ });
    remove.click();

    await waitFor(() => expect(screen.queryByTestId("saved-reports-list")).toBeNull());
    const saves = rpcMock.mock.calls.filter((call) => call[0] === "findback_save_post_client");
    const unsaves = rpcMock.mock.calls.filter((call) => call[0] === "findback_unsave_post_client");
    expect(saves).toHaveLength(0);
    expect(unsaves.length).toBeGreaterThanOrEqual(1);
    // The device never gained a copy of a save the reader took away.
    expect(readSavedReports("u1")).toHaveLength(0);
  });

  it("does not save anything when the account cannot be reached at all", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "does not exist" } });
    renderScreen();

    expect(await screen.findByText("Couldn't load your saved reports.")).toBeTruthy();
    expect(
      rpcMock.mock.calls.filter((call) => call[0] === "findback_save_post_client"),
    ).toHaveLength(0);
  });

  it("does not call an account-held save temporary when the browser blocks storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      // The account confirms the save: it is on the account, and only the
      // DEVICE copy is missing.
      rpcMock.mockImplementation(async (name: string) => {
        if (name === "findback_list_saved_posts_client") {
          return { data: { items: [], complete: true }, error: null };
        }
        return { data: true, error: null };
      });
      fetchPostMock.mockResolvedValue({ id: "p1", title: "Lost keys" });
      renderScreenWithSave();

      fireEvent.click(screen.getByTestId("save-report-button"));

      await waitFor(() =>
        expect(screen.getByTestId("saved-reports-storage").textContent).toBe(
          "Saved to your account",
        ),
      );
      // The row says where the copy is missing — not that the save is
      // temporary.
      expect(screen.getByText(/Not stored on this device/)).toBeTruthy();
      expect(screen.queryByText(/For this session only/)).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("every saved report is reachable", () => {
  /** Twenty-one saved reports, so the twenty-first is past the first page. */
  function saveTwentyOne() {
    for (let index = 1; index <= 21; index += 1) {
      writeSavedReport("u1", { postId: `p${index}`, title: `Report ${index}` });
    }
    fetchPostMock.mockImplementation(async (id: string) => ({ id, title: `Report ${id}` }));
    // The account holds them too: the list is the whole list, so a report it
    // does not hold is one that was removed on another device.
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") {
        const ids = authState.userId === "u1"
          ? Array.from({ length: 21 }, (_, index) => `p${index + 1}`)
          : [];
        return {
          data: {
            items: ids.map((post_id) => ({ post_id, saved_at: "2026-10-20T10:00:00+00:00" })),
            complete: true,
          },
          error: null,
        };
      }
      return { data: true, error: null };
    });
  }

  it("shows the report past the first page when the reader asks for more", async () => {
    saveTwentyOne();
    renderScreen();

    const list = await screen.findByTestId("saved-reports-list");
    const links = () =>
      within(list).getAllByRole("link").map((link) => link.getAttribute("href"));

    // The first page holds twenty, and the reader is told what is left.
    await waitFor(() => expect(links()).toHaveLength(20));
    expect(screen.getByText("1 more saved report not shown.")).toBeTruthy();
    const firstPage = links();

    fireEvent.click(screen.getByRole("button", { name: /show more/i }));

    // The report that was past the page is on the page now.
    await waitFor(() => expect(links()).toHaveLength(21));
    const revealed = links().find((href) => !firstPage.includes(href));
    expect(revealed).toBeTruthy();

    // And it is a normal row: it can be removed like any other.
    const revealedId = revealed!.replace("/posts/", "");
    fireEvent.click(
      screen.getByRole("button", { name: `Remove Report ${revealedId} from saved reports` }),
    );

    await waitFor(() => expect(links()).toHaveLength(20));
    expect(links()).not.toContain(revealed);
    // The reports before it are untouched.
    expect(links()).toEqual(expect.arrayContaining(firstPage));
  });

  it("starts at the first page again when the account changes", async () => {
    saveTwentyOne();
    const view = render(screenTree());
    await screen.findByTestId("saved-reports-list");
    fireEvent.click(screen.getByRole("button", { name: /show more/i }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("saved-reports-list")).getAllByRole("link"),
      ).toHaveLength(21),
    );

    // Another reader signs in: their list is their own.
    authState.userId = "u2";
    view.rerender(screenTree());
    expect(await screen.findByText("No saved reports yet")).toBeTruthy();

    // And coming back to the first reader does not carry the old paging over.
    authState.userId = "u1";
    view.rerender(screenTree());
    await waitFor(() =>
      expect(
        within(screen.getByTestId("saved-reports-list")).getAllByRole("link"),
      ).toHaveLength(20),
    );
    expect(screen.getByRole("button", { name: /show more/i })).toBeTruthy();
  });
});
