// @vitest-environment jsdom
/**
 * The saved-reports provider: it is the ONE owner of the saved state. The
 * device write is the immediate truth, the account is a best-effort adapter,
 * the intent is explicit (a removal is never a toggle), the account is a scope
 * (one reader's reports never reach the next one), and nothing is claimed
 * that did not happen.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, authState } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  authState: { userId: "u1" as string | null },
}));

vi.mock("../services/supabaseClient", () => ({ getSupabase: () => ({ rpc: rpcMock }) }));
vi.mock("../auth", () => ({
  useAuth: () => ({ user: authState.userId ? { id: authState.userId, username: "alice" } : null }),
}));

import { SavedReportsProvider, useSavedReports } from "./useSavedReports";
import {
  SAVED_REPORTS_REMOVALS_STORAGE_PREFIX,
  markSavedReportSynced,
  readSavedReportRemovals,
  readSavedReports,
  writeSavedReport,
} from "../services/savedReports";

/**
 * Write a removal intent with a chosen moment.
 *
 * The intent's moment decides who wins: an account save NEWER than the removal
 * is the newer intent, an older one loses.
 */
function writeRemovalIntent(postId: string, removedAt: string) {
  localStorage.setItem(
    `${SAVED_REPORTS_REMOVALS_STORAGE_PREFIX}:u1`,
    JSON.stringify([{ postId, removedAt }]),
  );
}

function Probe({ postId = "p1" }: { postId?: string }) {
  const saved = useSavedReports();
  return (
    <div>
      <span data-testid="saved-ids">{saved.savedIds.join(",")}</span>
      <span data-testid="rows">{saved.rows.map((row) => row.id).join(",")}</span>
      <span data-testid="is-saved">{saved.isSaved(postId) ? "yes" : "no"}</span>
      <span data-testid="pending">{saved.pending ? "yes" : "no"}</span>
      <span data-testid="error">{saved.error ?? ""}</span>
      <span data-testid="synced">{saved.syncedToAccount ? "yes" : "no"}</span>
      <span data-testid="storage-healthy">{saved.storageHealthy ? "yes" : "no"}</span>
      <span data-testid="on-account">
        {saved.rows.filter((row) => row.onAccount).map((row) => row.id).join(",")}
      </span>
      <button type="button" data-testid="toggle" onClick={() => void saved.toggle(postId, "Lost keys")}>
        toggle
      </button>
      <button type="button" data-testid="remove" onClick={() => void saved.remove(postId)}>
        remove
      </button>
      <button type="button" data-testid="save-other" onClick={() => void saved.save("p2", "Found cat")}>
        save other
      </button>
      <button type="button" data-testid="remove-other" onClick={() => void saved.remove("p2")}>
        remove other
      </button>
      <button type="button" data-testid="retry" onClick={() => saved.retry()}>
        retry
      </button>
    </div>
  );
}

/** The ids of the rows on screen, in a stable order. */
function rowIds(): string[] {
  return (screen.getByTestId("rows").textContent ?? "").split(",").filter(Boolean).sort();
}

/**
 * Let the account's answer land and the hydrate settle it.
 *
 * The answer travels through promises, so one turn of the event loop is
 * enough to let the whole chain finish — and waiting for it is what makes an
 * assertion about the settled state honest.
 */
async function settleHydrate() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderProvider(postId = "p1") {
  return render(
    <SavedReportsProvider>
      <Probe postId={postId} />
    </SavedReportsProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  rpcMock.mockReset();
  authState.userId = "u1";
  // The account list call: the account answered and holds nothing.
  rpcMock.mockResolvedValue({ data: { items: [], complete: true }, error: null });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SavedReportsProvider", () => {
  it("saves and unsaves on the device, immediately", async () => {
    renderProvider();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("toggle"));

    // The device list is the truth the moment the tap lands.
    expect(screen.getByTestId("is-saved").textContent).toBe("yes");
    expect(screen.getByTestId("saved-ids").textContent).toBe("p1");
    expect(readSavedReports("u1")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("toggle"));
    await waitFor(() => expect(screen.getByTestId("is-saved").textContent).toBe("no"));
    expect(readSavedReports("u1")).toHaveLength(0);
  });

  it("keeps the save and says so when the account cannot be reached", async () => {
    // The list call answers; the save call does not.
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") return { data: { items: [], complete: true }, error: null };
      return { data: null, error: { message: "does not exist" } };
    });
    renderProvider();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("toggle"));

    await waitFor(() => expect(screen.getByTestId("error").textContent).not.toBe(""));
    expect(screen.getByTestId("error").textContent).toMatch(/saved on this device/i);
    expect(screen.getByTestId("is-saved").textContent).toBe("yes");
    expect(screen.getByTestId("synced").textContent).toBe("no");
    expect(readSavedReports("u1")[0]!.synced).toBe(false);
  });

  it("drops the stale account-failure note once the account confirms the save", async () => {
    // The server TOOK the save but the reply was lost: the reader saw a
    // failure while the account already holds the report. A later answer
    // confirms it, so the note has to go with it — a row that claims "on this
    // device only" for a report the account holds contradicts the footer.
    let accountHolds = false;
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") {
        return accountHolds
          ? {
              data: {
                complete: true,
                items: [{ post_id: "p1", saved_at: new Date().toISOString() }],
              },
              error: null,
            }
          : { data: { complete: true, items: [] }, error: null };
      }
      // The save call fails: the reply is lost, the write is not.
      return { data: null, error: { message: "does not exist" } };
    });
    renderProvider();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("toggle"));

    await waitFor(() => expect(screen.getByTestId("error").textContent).not.toBe(""));
    expect(screen.getByTestId("error").textContent).toMatch(/saved on this device/i);

    // The account answers again, and it HOLDS the report.
    accountHolds = true;
    fireEvent.click(screen.getByTestId("retry"));

    await waitFor(() => expect(screen.getByTestId("on-account").textContent).toBe("p1"));
    expect(screen.getByTestId("error").textContent).toBe("");
    expect(screen.getByTestId("synced").textContent).toBe("yes");
  });

  it("marks the save as synced when the account confirms it", async () => {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") return { data: { items: [], complete: true }, error: null };
      return { data: true, error: null };
    });
    renderProvider();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("toggle"));

    await waitFor(() => expect(screen.getByTestId("synced").textContent).toBe("yes"));
    expect(screen.getByTestId("error").textContent).toBe("");
    expect(readSavedReports("u1")[0]!.synced).toBe(true);
  });

  it("never swallows a tap that lands while the account is still catching up", async () => {
    let release!: (value: unknown) => void;
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") return { data: { items: [], complete: true }, error: null };
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    renderProvider();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("toggle"));
    expect(screen.getByTestId("is-saved").textContent).toBe("yes");

    // The undo lands while the account call is still in flight: the device
    // list follows the reader immediately.
    fireEvent.click(screen.getByTestId("toggle"));
    expect(screen.getByTestId("is-saved").textContent).toBe("no");

    await act(async () => {
      release({ data: true, error: null });
    });
    // The account is then brought in line with what the reader wanted last.
    await waitFor(() =>
      expect(
        rpcMock.mock.calls.filter((call) => call[0] === "findback_unsave_post_client"),
      ).toHaveLength(1),
    );
  });

  it("adopts the reports the account holds that this device does not", async () => {
    rpcMock.mockResolvedValue({
      data: { items: [{ post_id: "p9", saved_at: "2026-10-20T10:00:00+00:00" }], complete: true },
      error: null,
    });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("saved-ids").textContent).toBe("p9"));
    expect(screen.getByTestId("is-saved").textContent).toBe("no");
  });

  it("leaves the device list alone when the account cannot be reached", async () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    rpcMock.mockResolvedValue({ data: null, error: { message: "does not exist" } });
    renderProvider();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    expect(screen.getByTestId("saved-ids").textContent).toBe("p1");
    expect(screen.getByTestId("is-saved").textContent).toBe("yes");
    expect(screen.getByTestId("error").textContent).toBe("");
  });
});

describe("the intent is explicit", () => {
  it("removes a report the account holds without ever saving it", async () => {
    // The account holds p9; this device knows nothing about it.
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") {
        return {
          data: { items: [{ post_id: "p9", saved_at: "2026-10-20T10:00:00+00:00" }], complete: true },
          error: null,
        };
      }
      return { data: true, error: null };
    });
    renderProvider("p9");
    await waitFor(() => expect(screen.getByTestId("rows").textContent).toBe("p9"));

    fireEvent.click(screen.getByTestId("remove"));

    await waitFor(() => expect(screen.getByTestId("rows").textContent).toBe(""));
    const saves = rpcMock.mock.calls.filter((call) => call[0] === "findback_save_post_client");
    const unsaves = rpcMock.mock.calls.filter((call) => call[0] === "findback_unsave_post_client");
    expect(saves).toHaveLength(0);
    expect(unsaves.length).toBeGreaterThanOrEqual(1);
    // The device never gained a copy of a save the reader took away.
    expect(readSavedReports("u1")).toHaveLength(0);
  });

  it("keeps a removal intent until the account drops the report", async () => {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") return { data: { items: [], complete: true }, error: null };
      return { data: null, error: { message: "offline" } };
    });
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    renderProvider();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("remove"));

    await waitFor(() => expect(readSavedReportRemovals("u1")).toHaveLength(1));
    expect(readSavedReportRemovals("u1")[0]!.postId).toBe("p1");
  });
});

describe("the account is a scope", () => {
  it("keeps a pending save out of the account that comes next", async () => {
    let release!: (value: unknown) => void;
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") return { data: { items: [], complete: true }, error: null };
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const view = renderProvider();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("toggle"));
    expect(screen.getByTestId("is-saved").textContent).toBe("yes");

    // The reader signs in as somebody else while that call is still in flight.
    authState.userId = "u2";
    view.rerender(
      <SavedReportsProvider>
        <Probe />
      </SavedReportsProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("saved-ids").textContent).toBe(""));
    expect(screen.getByTestId("is-saved").textContent).toBe("no");
    expect(readSavedReports("u2")).toHaveLength(0);

    // The first account's call answers late: it belongs to the reader who is
    // gone and must not write into the new account.
    await act(async () => {
      release({ data: true, error: null });
    });
    expect(screen.getByTestId("saved-ids").textContent).toBe("");
    expect(screen.getByTestId("is-saved").textContent).toBe("no");
    expect(readSavedReports("u2")).toHaveLength(0);
    // And nothing else is dispatched under the new account.
    const writes = rpcMock.mock.calls.filter(
      (call) => call[0] !== "findback_list_saved_posts_client",
    );
    expect(writes).toHaveLength(1);
  });
});

describe("a removal is durable", () => {
  it("does not let a late account list undo a removal", async () => {
    let release!: (value: unknown) => void;
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return { data: true, error: null };
    });
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    renderProvider();
    // The account list is still in flight when the reader removes the report.
    fireEvent.click(screen.getByTestId("toggle"));
    expect(readSavedReports("u1")).toHaveLength(0);
    expect(screen.getByTestId("is-saved").textContent).toBe("no");

    // The answer that arrives now is OLDER than the removal: it must not
    // bring the report back.
    await act(async () => {
      release({
        data: { items: [{ post_id: "p1", saved_at: "2026-10-20T10:00:00+00:00" }], complete: true },
        error: null,
      });
    });
    await waitFor(() => expect(screen.getByTestId("saved-ids").textContent).toBe(""));
    expect(screen.getByTestId("is-saved").textContent).toBe("no");
    expect(readSavedReports("u1")).toHaveLength(0);
  });

  it("syncs a save that never reached the account when the account answers later", async () => {
    // The first launch: the account is unreachable, the save stays on the device.
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    rpcMock.mockResolvedValue({ data: null, error: { message: "offline" } });
    const view = renderProvider();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    view.unmount();

    // The next launch: the account answers and does not hold the save yet.
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") return { data: { items: [], complete: true }, error: null };
      return { data: true, error: null };
    });
    renderProvider();
    await waitFor(() =>
      expect(
        rpcMock.mock.calls.filter((call) => call[0] === "findback_save_post_client").length,
      ).toBeGreaterThanOrEqual(1),
    );
    expect(readSavedReports("u1")[0]!.synced).toBe(true);
  });

  it("does not bring a removed report back on the next launch", async () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    // The account cannot be reached: the removal happens offline.
    rpcMock.mockResolvedValue({ data: null, error: { message: "does not exist" } });
    const view = renderProvider();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("toggle"));
    expect(readSavedReports("u1")).toHaveLength(0);
    view.unmount();

    // The next launch: the account answers and still holds the report.
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") {
        return {
          data: { items: [{ post_id: "p1", saved_at: "2026-10-20T10:00:00+00:00" }], complete: true },
          error: null,
        };
      }
      return { data: true, error: null };
    });
    renderProvider();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());
    // The removal the reader made is still in force: the report does not come
    // back, and the account is asked to drop it.
    expect(screen.getByTestId("saved-ids").textContent).toBe("");
    expect(screen.getByTestId("is-saved").textContent).toBe("no");
    await waitFor(() =>
      expect(
        rpcMock.mock.calls.filter((call) => call[0] === "findback_unsave_post_client").length,
      ).toBeGreaterThanOrEqual(1),
    );
  });
});

describe("the session keeps every save", () => {
  it("keeps every session save when the browser blocks storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      renderProvider();
      await waitFor(() => expect(rpcMock).toHaveBeenCalled());

      fireEvent.click(screen.getByTestId("toggle")); // p1
      fireEvent.click(screen.getByTestId("save-other")); // p2

      // Both saves are what the reader sees, even though neither reached the
      // disk: the session is the truth until the store can be written.
      expect(rowIds()).toEqual(["p1", "p2"]);
      expect(readSavedReports("u1")).toHaveLength(0);

      // A removal must not take the other save with it.
      fireEvent.click(screen.getByTestId("remove-other"));
      expect(rowIds()).toEqual(["p1"]);

      // And a retry must not drop what the reader can still see.
      fireEvent.click(screen.getByTestId("retry"));
      await waitFor(() =>
        expect(
          rpcMock.mock.calls.filter((call) => call[0] === "findback_list_saved_posts_client")
            .length,
        ).toBeGreaterThanOrEqual(2),
      );
      expect(rowIds()).toEqual(["p1"]);
    } finally {
      setItem.mockRestore();
    }
  });

  it("persists the whole session list once the store recovers", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      renderProvider();
      await waitFor(() => expect(rpcMock).toHaveBeenCalled());
      fireEvent.click(screen.getByTestId("toggle")); // p1 — session only
      fireEvent.click(screen.getByTestId("save-other")); // p2 — session only
      expect(readSavedReports("u1")).toHaveLength(0);
    } finally {
      setItem.mockRestore();
    }

    // The store comes back: the next write takes the whole list with it, not
    // just the report that was tapped.
    fireEvent.click(screen.getByTestId("save-other"));
    await waitFor(() => expect(readSavedReports("u1")).toHaveLength(2));
    expect(readSavedReports("u1").map((entry) => entry.postId).sort()).toEqual(["p1", "p2"]);
  });
});

describe("the account's confirmation is the truth", () => {
  it("records the account's confirmation after a successful save", async () => {
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") return { data: { items: [], complete: true }, error: null };
      return { data: true, error: null };
    });
    renderProvider();
    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("toggle"));

    // The account confirmed the save: the row says the account holds it, and
    // the account was not asked a second time to prove it.
    await waitFor(() => expect(screen.getByTestId("on-account").textContent).toBe("p1"));
    const lists = rpcMock.mock.calls.filter(
      (call) => call[0] === "findback_list_saved_posts_client",
    );
    expect(lists).toHaveLength(1);
  });

  it("does not let a confirmation the reader has outgrown put the report back", async () => {
    const pending: Array<(value: unknown) => void> = [];
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") {
        return {
          data: { items: [{ post_id: "p1", saved_at: "2026-10-20T10:00:00+00:00" }], complete: true },
          error: null,
        };
      }
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("on-account").textContent).toBe("p1"));

    // The reader removes the report and changes their mind before the account
    // answers: the removal is in flight, the reader wants it saved again.
    fireEvent.click(screen.getByTestId("remove"));
    fireEvent.click(screen.getByTestId("toggle"));
    expect(screen.getByTestId("is-saved").textContent).toBe("yes");

    // The removal is confirmed late. It tells the truth about the account —
    // the account dropped the report — but it does not decide that the report
    // is saved, and the correction that is already queued still runs.
    await act(async () => {
      pending[0]!({ data: true, error: null });
    });
    expect(screen.getByTestId("on-account").textContent).toBe("");
    await waitFor(() =>
      expect(
        rpcMock.mock.calls.filter((call) => call[0] === "findback_save_post_client").length,
      ).toBeGreaterThanOrEqual(1),
    );
  });
});

describe("honest about the device", () => {
  it("does not claim a durable save when the browser blocks storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      rpcMock.mockImplementation(async (name: string) => {
        if (name === "findback_list_saved_posts_client") {
          return { data: { items: [], complete: true }, error: null };
        }
        return { data: true, error: null };
      });
      renderProvider();
      fireEvent.click(screen.getByTestId("toggle"));

      await waitFor(() => expect(screen.getByTestId("error").textContent).not.toBe(""));
      // The save IS on the account — only the DEVICE copy is missing — so the
      // surface says where the save lives, not that it is temporary.
      expect(screen.getByTestId("error").textContent).toMatch(/saved to your account/i);
      expect(screen.getByTestId("on-account").textContent).toBe("p1");
      // The session keeps the save; the disk does not, and the UI says so.
      expect(screen.getByTestId("is-saved").textContent).toBe("yes");
      expect(screen.getByTestId("storage-healthy").textContent).toBe("no");
      expect(readSavedReports("u1")).toHaveLength(0);
    } finally {
      setItem.mockRestore();
    }
  });

  it("says the save is only for this session when the account does not hold it", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      // The account cannot be reached, so the save never got there.
      rpcMock.mockImplementation(async (name: string) => {
        if (name === "findback_list_saved_posts_client") {
          return { data: { items: [], complete: true }, error: null };
        }
        return { data: null, error: { message: "does not exist" } };
      });
      renderProvider();
      fireEvent.click(screen.getByTestId("toggle"));

      await waitFor(() => expect(screen.getByTestId("error").textContent).not.toBe(""));
      expect(screen.getByTestId("error").textContent).toMatch(/session only/i);
      expect(screen.getByTestId("is-saved").textContent).toBe("yes");
      expect(screen.getByTestId("storage-healthy").textContent).toBe("no");
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("the account and this device disagree", () => {
  const minute = 60 * 1000;
  const hour = 60 * minute;

  it("keeps a report the account saved again after the local removal", async () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    markSavedReportSynced("u1", "p1", true);
    // The reader removed it an hour ago; another device saved it a minute ago.
    writeRemovalIntent("p1", new Date(Date.now() - hour).toISOString());
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") {
        return {
          data: {
            items: [{ post_id: "p1", saved_at: new Date(Date.now() - minute).toISOString() }],
            complete: true,
          },
          error: null,
        };
      }
      return { data: true, error: null };
    });
    renderProvider();

    // The account's save is the newer intent: the removal is stale, the
    // report stays, and the account is NOT asked to drop it.
    await waitFor(() => expect(screen.getByTestId("rows").textContent).toBe("p1"));
    expect(screen.getByTestId("is-saved").textContent).toBe("yes");
    expect(
      rpcMock.mock.calls.filter((call) => call[0] === "findback_unsave_post_client"),
    ).toHaveLength(0);
    // The stale intent is settled in the disk AND in the session.
    expect(readSavedReportRemovals("u1")).toHaveLength(0);
  });

  it("adopts the account's newer save when the removal only exists in the session", async () => {
    // The disk holds the report, and so does the account.
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    markSavedReportSynced("u1", "p1", true);
    // The account saved it again AFTER the removal below: its clock reads a
    // minute ahead of this device's.
    const savedAt = new Date(Date.now() + minute).toISOString();
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") {
        return {
          data: { items: [{ post_id: "p1", saved_at: savedAt }], complete: true },
          error: null,
        };
      }
      // The removal cannot reach the account: the intent has to survive.
      return { data: null, error: { message: "offline" } };
    });

    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      renderProvider();
      // The account's answer lands before the reader acts: the account holds
      // the report, and that is what the row says.
      await waitFor(() => expect(screen.getByTestId("on-account").textContent).toBe("p1"));

      // The reader removes it while the browser blocks storage: the intent
      // exists ONLY in the session — the disk never saw it.
      fireEvent.click(screen.getByTestId("remove"));
      await waitFor(() =>
        expect(
          rpcMock.mock.calls.filter((call) => call[0] === "findback_unsave_post_client"),
        ).toHaveLength(1),
      );
      expect(readSavedReportRemovals("u1")).toHaveLength(0);
      expect(screen.getByTestId("is-saved").textContent).toBe("no");
    } finally {
      setItem.mockRestore();
    }

    // The store comes back and the reader asks again.
    fireEvent.click(screen.getByTestId("retry"));
    await waitFor(() => expect(screen.getByTestId("rows").textContent).toBe("p1"));

    // The account's save is the newer intent, even though the removal only
    // lived in the session: the report comes back, the stale intent is gone,
    // and the account is NOT asked to drop the report it saved.
    expect(screen.getByTestId("is-saved").textContent).toBe("yes");
    expect(screen.getByTestId("on-account").textContent).toBe("p1");
    expect(
      rpcMock.mock.calls.filter((call) => call[0] === "findback_unsave_post_client"),
    ).toHaveLength(1);
  });

  it("keeps the removal when the account's save is older than it", async () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    markSavedReportSynced("u1", "p1", true);
    // The account saved it a day before the removal.
    writeRemovalIntent("p1", new Date(Date.now() - minute).toISOString());
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") {
        return {
          data: {
            items: [{ post_id: "p1", saved_at: new Date(Date.now() - 24 * hour).toISOString() }],
            complete: true,
          },
          error: null,
        };
      }
      return { data: true, error: null };
    });
    renderProvider();

    // The removal is the newer intent: the report stays out of the list and
    // the account is asked to drop it.
    await waitFor(() =>
      expect(
        rpcMock.mock.calls.filter((call) => call[0] === "findback_unsave_post_client").length,
      ).toBeGreaterThanOrEqual(1),
    );
    expect(screen.getByTestId("rows").textContent).toBe("");
    expect(readSavedReportRemovals("u1")).toHaveLength(1);
  });

  it("drops a record the account removed on another device, and never saves it again", async () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    markSavedReportSynced("u1", "p1", true);
    // The account's list is the whole list and it does not hold the report.
    rpcMock.mockResolvedValue({ data: { items: [], complete: true }, error: null });
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("rows").textContent).toBe(""));
    // The local record goes with it — and nothing is saved again.
    expect(readSavedReports("u1")).toHaveLength(0);
    expect(
      rpcMock.mock.calls.filter((call) => call[0] === "findback_save_post_client"),
    ).toHaveLength(0);
    // There was nothing to unsave: no intent is kept.
    expect(readSavedReportRemovals("u1")).toHaveLength(0);
  });

  it("keeps a record an incomplete list does not list, and never saves it again", async () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    markSavedReportSynced("u1", "p1", true);
    // The account's list may be truncated: it does NOT prove a removal.
    rpcMock.mockResolvedValue({ data: { items: [], complete: false }, error: null });
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("rows").textContent).toBe("p1"));
    expect(readSavedReports("u1")).toHaveLength(1);
    expect(
      rpcMock.mock.calls.filter((call) => call[0] === "findback_save_post_client"),
    ).toHaveLength(0);
    // And the reader is told the account did not list it.
    expect(screen.getByTestId("error").textContent).toMatch(/did not list it/i);
  });

  it("keeps a removal intent an incomplete list cannot settle", async () => {
    // A removal the account never saw: the intent is on the disk.
    writeRemovalIntent("p1", new Date(Date.now() - minute).toISOString());
    let complete = false;
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") {
        return {
          data: {
            items: complete
              ? [{ post_id: "p1", saved_at: new Date(Date.now() - 24 * hour).toISOString() }]
              : [],
            complete,
          },
          error: null,
        };
      }
      return { data: true, error: null };
    });
    renderProvider();

    // The list may be truncated, so its silence does NOT prove the removal
    // landed: the intent stays, and no unsave is invented out of a list that
    // never claimed to hold the report.
    await settleHydrate();
    expect(screen.getByTestId("rows").textContent).toBe("");
    expect(readSavedReportRemovals("u1")).toHaveLength(1);
    expect(
      rpcMock.mock.calls.filter((call) => call[0] === "findback_unsave_post_client"),
    ).toHaveLength(0);

    // The account answers with the WHOLE list and still holds the report, with
    // a stamp older than the removal: the removal is the newer intent.
    complete = true;
    fireEvent.click(screen.getByTestId("retry"));
    await waitFor(() =>
      expect(
        rpcMock.mock.calls.filter((call) => call[0] === "findback_unsave_post_client").length,
      ).toBeGreaterThanOrEqual(1),
    );
    // The intent stands and the report is not resurrected.
    expect(screen.getByTestId("rows").textContent).toBe("");
    expect(screen.getByTestId("is-saved").textContent).toBe("no");
    expect(readSavedReportRemovals("u1")).toHaveLength(1);
  });

  it("settles the conflict when the account lists the report again", async () => {
    writeSavedReport("u1", { postId: "p1", title: "Lost keys" });
    markSavedReportSynced("u1", "p1", true);
    let complete = false;
    rpcMock.mockImplementation(async (name: string) => {
      if (name === "findback_list_saved_posts_client") {
        return {
          data: {
            items: complete ? [{ post_id: "p1", saved_at: "2026-10-20T10:00:00+00:00" }] : [],
            complete,
          },
          error: null,
        };
      }
      return { data: true, error: null };
    });
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("error").textContent).toMatch(/did not list it/i));

    // The account lists it the next time the reader asks: the conflict is over.
    complete = true;
    fireEvent.click(screen.getByTestId("retry"));
    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe(""));
    expect(screen.getByTestId("rows").textContent).toBe("p1");
  });

  it("keeps every id the account holds, however many there are", async () => {
    const items = Array.from({ length: 201 }, (_, index) => ({
      post_id: `p${index + 1}`,
      saved_at: "2026-10-20T10:00:00+00:00",
    }));
    rpcMock.mockResolvedValue({ data: { items, complete: true }, error: null });
    renderProvider();

    // The device keeps 200 as its cache budget, but the ACCOUNT's saves are
    // never dropped.
    await waitFor(() => expect(rowIds()).toHaveLength(201));
  });
});

describe("useSavedReports outside a provider", () => {
  it("is inert and never throws", async () => {
    render(<Probe />);
    expect(screen.getByTestId("is-saved").textContent).toBe("no");
    expect(screen.getByTestId("saved-ids").textContent).toBe("");
    expect(screen.getByTestId("pending").textContent).toBe("no");
    expect(screen.getByTestId("error").textContent).toBe("");

    await act(async () => {
      fireEvent.click(screen.getByTestId("toggle"));
      fireEvent.click(screen.getByTestId("remove"));
    });
    expect(screen.getByTestId("is-saved").textContent).toBe("no");
    expect(readSavedReports("u1")).toHaveLength(0);
  });
});
