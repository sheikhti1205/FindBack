// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PostItem } from "@findback/shared";
import { ApiError } from "../services/session";

const { mockMarkRecovered, mockSearchProfiles, mockInvalidate, viewer } = vi.hoisted(() => ({
  mockMarkRecovered: vi.fn(),
  mockSearchProfiles: vi.fn(),
  mockInvalidate: vi.fn(),
  viewer: { id: "u1" },
}));

vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: viewer.id } }) }));

// Keep the real vocabulary and helper labels; replace only the two network
// calls so the sheet is exercised as written.
vi.mock("../services/trust", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/trust")>();
  return {
    ...actual,
    markRecovered: (...args: unknown[]) => mockMarkRecovered(...args),
  };
});
vi.mock("../hooks/feedCache", () => ({ invalidateFeedCaches: mockInvalidate }));
vi.mock("../services/profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/profile")>();
  return {
    ...actual,
    searchProfilesByPrefix: (...args: unknown[]) => mockSearchProfiles(...args),
  };
});

import { RecoverySheet } from "./RecoverySheet";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  mockMarkRecovered.mockReset();
  mockSearchProfiles.mockReset();
  mockInvalidate.mockReset();
  viewer.id = "u1";
  mockMarkRecovered.mockResolvedValue("ret-1");
  mockSearchProfiles.mockResolvedValue([
    { id: "u2", username: "alice", displayName: "Alice Khan", avatarUrl: null },
  ]);
});

function lostPost(overrides: Partial<PostItem> = {}): PostItem {
  return {
    id: "p1",
    userId: "u1",
    author: { id: "u1", username: "owner" },
    type: "LOST",
    status: "OPEN",
    title: "Brown wallet",
    description: "Leather wallet",
    category: "Wallet",
    eventDate: "2026-10-01",
    latitude: 23.8,
    longitude: 90.4,
    locationLabel: "Dhanmondi",
    youtubeUrl: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    likeCount: 0,
    dislikeCount: 0,
    ratingAvg: null,
    ratingCount: 0,
    commentCount: 0,
    attachments: [],
    ...overrides,
  } as PostItem;
}

function renderSheet(overrides: { onClose?: () => void; onRecovered?: (id: string, p: PostItem) => void; onRate?: () => void } = {}) {
  const post = lostPost();
  const props = {
    open: true,
    post,
    onClose: overrides.onClose ?? (() => {}),
    onRecovered: overrides.onRecovered,
    onRate: overrides.onRate,
  };
  const view = render(<RecoverySheet {...props} />);
  return { ...view, post };
}

/** Listen for the shared live-region event so silence is provable. */
function announcements(): string[] {
  const heard: string[] = [];
  window.addEventListener("findback:announce", ((event: CustomEvent<string>) => {
    heard.push(event.detail);
  }) as EventListener);
  return heard;
}

describe("RecoverySheet", () => {
  it("asks who returned the item in reader words, with no server vocabulary", () => {
    renderSheet();
    expect(screen.getByRole("radio", { name: /someone on findback/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /someone outside findback/i })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /i found it myself/i })).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("FINDBACK_USER");
    expect(text).not.toContain("SELF_OR_PRIVATE");
    expect(text).not.toMatch(/helper_kind|findback_mark_recovered|\brpc\b/i);
  });

  it("keeps the confirmation disabled until a helper kind is chosen", () => {
    renderSheet();
    const confirm = screen.getByRole("button", { name: /mark recovered/i });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(mockMarkRecovered).not.toHaveBeenCalled();
  });

  it("marks an outside return without naming an account", async () => {
    const onRecovered = vi.fn();
    renderSheet({ onRecovered });
    fireEvent.click(screen.getByRole("radio", { name: /someone outside findback/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));

    await waitFor(() => expect(mockMarkRecovered).toHaveBeenCalledTimes(1));
    expect(mockMarkRecovered).toHaveBeenCalledWith({
      postId: "p1",
      helperKind: "OUTSIDE",
      helperUserId: null,
    });
    expect(await screen.findByTestId("recovery-receipt")).toBeTruthy();
    expect(screen.getByText(/recovery saved/i)).toBeTruthy();
    expect(onRecovered).toHaveBeenCalledWith("ret-1", expect.objectContaining({ id: "p1" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("marks a self or private return without an account", async () => {
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /i found it myself/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));
    await waitFor(() => expect(mockMarkRecovered).toHaveBeenCalledTimes(1));
    expect(mockMarkRecovered).toHaveBeenCalledWith({
      postId: "p1",
      helperKind: "SELF_OR_PRIVATE",
      helperUserId: null,
    });
  });

  it("finds another account and sends its id", async () => {
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /someone on findback/i }));
    const search = screen.getByLabelText(/find the account/i);
    fireEvent.change(search, { target: { value: "ali" } });

    const result = await screen.findByRole("button", { name: /alice khan.*@alice/i });
    fireEvent.click(result);
    expect(screen.getByTestId("recovery-helper-selected")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));
    await waitFor(() => expect(mockMarkRecovered).toHaveBeenCalledTimes(1));
    expect(mockMarkRecovered).toHaveBeenCalledWith({
      postId: "p1",
      helperKind: "FINDBACK_USER",
      helperUserId: "u2",
    });
  });

  it("refuses to send a FindBack return without a selected account", async () => {
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /someone on findback/i }));
    fireEvent.change(screen.getByLabelText(/find the account/i), { target: { value: "ali" } });
    await screen.findByRole("button", { name: /alice khan.*@alice/i });
    // No result selected yet: the action stays disabled rather than sending a
    // nameless account.
    const confirm = screen.getByRole("button", { name: /mark recovered/i });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(mockMarkRecovered).not.toHaveBeenCalled();
  });

  it("shows the server's refusal and keeps the form for a second attempt", async () => {
    mockMarkRecovered.mockRejectedValueOnce(new ApiError("duplicate key", 409, "23505"));
    const onRecovered = vi.fn();
    renderSheet({ onRecovered });
    fireEvent.click(screen.getByRole("radio", { name: /someone outside findback/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));

    expect(await screen.findByTestId("recovery-error")).toBeTruthy();
    expect(screen.getByText(/already been marked recovered/i)).toBeTruthy();
    expect(screen.queryByTestId("recovery-receipt")).toBeNull();
    expect(onRecovered).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: /mark recovered/i });
    expect(confirm.hasAttribute("disabled")).toBe(false);
  });

  it("phrases an ownership refusal without echoing the server", async () => {
    mockMarkRecovered.mockRejectedValueOnce(new ApiError("42501 permission denied", 403, "42501"));
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /someone outside findback/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));
    expect(await screen.findByText(/only the owner of a report/i)).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/42501|permission denied/i);
  });

  it("tells a self-helper apart from a FOUND report refusal", async () => {
    mockMarkRecovered.mockRejectedValueOnce(
      new ApiError("A FindBack helper must be another account; mark a self-recovery as self or private", 400, "22023"),
    );
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /someone on findback/i }));
    fireEvent.change(screen.getByLabelText(/find the account/i), { target: { value: "ali" } });
    fireEvent.click(await screen.findByRole("button", { name: /alice khan.*@alice/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));
    expect(await screen.findByText(/choose another account, or mark it as found yourself/i)).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/self-recovery as self or private/i);
  });

  it("offers the rating route only when the return names another account", async () => {
    const onRate = vi.fn();
    const onClose = vi.fn();
    renderSheet({ onRate, onClose });
    fireEvent.click(screen.getByRole("radio", { name: /someone on findback/i }));
    fireEvent.change(screen.getByLabelText(/find the account/i), { target: { value: "ali" } });
    fireEvent.click(await screen.findByRole("button", { name: /alice khan.*@alice/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));

    const rate = await screen.findByRole("button", { name: /rate the return/i });
    expect(screen.getByText(/where you can rate the return/i)).toBeTruthy();
    fireEvent.click(rate);
    expect(onRate).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not promise a rating for an outside or private return", async () => {
    const onRate = vi.fn();
    renderSheet({ onRate });
    fireEvent.click(screen.getByRole("radio", { name: /someone outside findback/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));
    await screen.findByTestId("recovery-receipt");
    expect(screen.queryByRole("button", { name: /rate the return/i })).toBeNull();
    expect(screen.queryByText(/where you can rate the return/i)).toBeNull();
    const view = screen.getByRole("button", { name: /view returns/i });
    fireEvent.click(view);
    expect(onRate).toHaveBeenCalledTimes(1);
  });

  it("drops a late completion after the sheet closes", async () => {
    let resolveMark: (value: string) => void = () => {};
    mockMarkRecovered.mockReturnValueOnce(new Promise<string>((resolve) => { resolveMark = resolve; }));
    const onRecovered = vi.fn();
    const heard = announcements();
    const view = renderSheet({ onRecovered });

    fireEvent.click(screen.getByRole("radio", { name: /someone outside findback/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));
    expect(mockMarkRecovered).toHaveBeenCalledTimes(1);

    view.rerender(
      <RecoverySheet open={false} post={view.post} onClose={() => {}} onRecovered={onRecovered} />,
    );
    await act(async () => {
      resolveMark("ret-late");
      await Promise.resolve();
    });

    expect(onRecovered).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
    expect(screen.queryByTestId("recovery-receipt")).toBeNull();
  });

  it("drops a late completion after the target report changes", async () => {
    let resolveMark: (value: string) => void = () => {};
    mockMarkRecovered.mockReturnValueOnce(new Promise<string>((resolve) => { resolveMark = resolve; }));
    const onRecovered = vi.fn();
    const first = lostPost();
    const second = lostPost({ id: "p2", title: "Black umbrella" });
    const view = render(
      <RecoverySheet open post={first} onClose={() => {}} onRecovered={onRecovered} />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /someone outside findback/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));
    view.rerender(
      <RecoverySheet open post={second} onClose={() => {}} onRecovered={onRecovered} />,
    );
    await act(async () => {
      resolveMark("ret-first");
      await Promise.resolve();
    });

    expect(onRecovered).not.toHaveBeenCalled();
    expect(screen.queryByTestId("recovery-receipt")).toBeNull();
  });

  it("announces the saved recovery once", async () => {
    const heard = announcements();
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /someone outside findback/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));
    await screen.findByTestId("recovery-receipt");
    expect(heard).toEqual(["Recovery saved."]);
  });

  it("invalidates the confirmed write's caches even after dismissal", async () => {
    let resolveMark: (value: string) => void = () => {};
    mockMarkRecovered.mockReturnValueOnce(new Promise<string>((resolve) => { resolveMark = resolve; }));
    const onRecovered = vi.fn();
    const heard = announcements();
    const view = renderSheet({ onRecovered });

    fireEvent.click(screen.getByRole("radio", { name: /someone outside findback/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));
    view.rerender(
      <RecoverySheet open={false} post={view.post} onClose={() => {}} onRecovered={onRecovered} />,
    );
    await act(async () => {
      resolveMark("ret-late");
      await Promise.resolve();
    });

    // The write is confirmed, so the cache must not keep a fresh OPEN row;
    // the dismissed dialog stays silent and does not patch a stale screen.
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
    expect(onRecovered).not.toHaveBeenCalled();
    expect(heard).toEqual([]);
  });

  it("drops a late completion when the parent's scope changes", async () => {
    let resolveMark: (value: string) => void = () => {};
    mockMarkRecovered.mockReturnValueOnce(new Promise<string>((resolve) => { resolveMark = resolve; }));
    const onRecovered = vi.fn();
    const post = lostPost();
    const view = render(
      <RecoverySheet open post={post} scopeKey="route:p1" onClose={() => {}} onRecovered={onRecovered} />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /someone outside findback/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));
    view.rerender(
      <RecoverySheet open post={post} scopeKey="route:p2" onClose={() => {}} onRecovered={onRecovered} />,
    );
    await act(async () => {
      resolveMark("ret-scope");
      await Promise.resolve();
    });

    expect(onRecovered).not.toHaveBeenCalled();
    expect(screen.queryByTestId("recovery-receipt")).toBeNull();
  });

  it("refuses a FOUND report inside the sheet itself", () => {
    render(<RecoverySheet open post={lostPost({ type: "FOUND" })} onClose={() => {}} />);
    expect(screen.getByText(/only a lost-item report can be marked recovered/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /mark recovered/i })).toBeNull();
    expect(mockMarkRecovered).not.toHaveBeenCalled();
  });

  it("refuses a report the viewer does not own", () => {
    viewer.id = "u9";
    render(<RecoverySheet open post={lostPost()} onClose={() => {}} />);
    expect(screen.getByText(/only the owner of a report can mark it recovered/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /mark recovered/i })).toBeNull();
  });

  it("sends at most once while the first request is pending", async () => {
    let resolveMark: (value: string) => void = () => {};
    mockMarkRecovered.mockReturnValueOnce(new Promise<string>((resolve) => { resolveMark = resolve; }));
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /someone outside findback/i }));
    const confirm = screen.getByRole("button", { name: /mark recovered/i });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(mockMarkRecovered).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("radio", { name: /someone outside findback/i }).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      resolveMark("ret-1");
      await Promise.resolve();
    });
  });

  it("tells a missing helper apart from a missing report", async () => {
    mockMarkRecovered.mockRejectedValueOnce(new ApiError("Helper not found", 404, "P0002"));
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /someone outside findback/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));
    expect(await screen.findByText(/that account is no longer available/i)).toBeTruthy();
    expect(screen.queryByText(/that report is no longer available/i)).toBeNull();
  });

  it("asks for the helper choice again on an unknown kind", async () => {
    mockMarkRecovered.mockRejectedValueOnce(new ApiError("Unknown helper kind", 400, "22023"));
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /someone outside findback/i }));
    fireEvent.click(screen.getByRole("button", { name: /mark recovered/i }));
    expect(await screen.findByText(/choose who returned the item again/i)).toBeTruthy();
  });

  it("never lets an older query replace a newer one", async () => {
    let resolveAli: (value: unknown[]) => void = () => {};
    let resolveBob: (value: unknown[]) => void = () => {};
    mockSearchProfiles.mockImplementation((prefix: string) =>
      prefix === "ali"
        ? new Promise((resolve) => { resolveAli = resolve; })
        : new Promise((resolve) => { resolveBob = resolve; }),
    );
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /someone on findback/i }));
    const search = screen.getByLabelText(/find the account/i);
    fireEvent.change(search, { target: { value: "ali" } });
    await waitFor(() => expect(mockSearchProfiles).toHaveBeenCalledWith("ali"));
    fireEvent.change(search, { target: { value: "bob" } });
    await waitFor(() => expect(mockSearchProfiles).toHaveBeenCalledWith("bob"));

    await act(async () => {
      resolveBob([{ id: "u3", username: "bob", displayName: "Bob", avatarUrl: null }]);
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: /bob/i })).toBeTruthy();

    await act(async () => {
      resolveAli([{ id: "u2", username: "alice", displayName: "Alice Khan", avatarUrl: null }]);
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: /alice khan/i })).toBeNull();
    expect((screen.getByLabelText(/find the account/i) as HTMLInputElement).value).toBe("bob");
  });

  it("drops a result that arrives after the query is cleared", async () => {
    let resolveAli: (value: unknown[]) => void = () => {};
    mockSearchProfiles.mockImplementation(() => new Promise((resolve) => { resolveAli = resolve; }));
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /someone on findback/i }));
    const search = screen.getByLabelText(/find the account/i);
    fireEvent.change(search, { target: { value: "ali" } });
    await waitFor(() => expect(mockSearchProfiles).toHaveBeenCalledWith("ali"));
    fireEvent.change(search, { target: { value: "" } });
    await act(async () => {
      resolveAli([{ id: "u2", username: "alice", displayName: "Alice Khan", avatarUrl: null }]);
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: /alice khan/i })).toBeNull();
  });

  it("drops an older error without disturbing the current search", async () => {
    let rejectAli: (error: unknown) => void = () => {};
    let resolveBob: (value: unknown[]) => void = () => {};
    mockSearchProfiles.mockImplementation((prefix: string) =>
      prefix === "ali"
        ? new Promise((_resolve, reject) => { rejectAli = reject; })
        : new Promise((resolve) => { resolveBob = resolve; }),
    );
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /someone on findback/i }));
    const search = screen.getByLabelText(/find the account/i);
    fireEvent.change(search, { target: { value: "ali" } });
    await waitFor(() => expect(mockSearchProfiles).toHaveBeenCalledWith("ali"));
    fireEvent.change(search, { target: { value: "bob" } });
    await waitFor(() => expect(mockSearchProfiles).toHaveBeenCalledWith("bob"));

    await act(async () => {
      rejectAli(new ApiError("search failed", 500));
      await Promise.resolve();
    });
    // The stale error must not paint an alert or clear the current spinner.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Searching…")).toBeTruthy();

    await act(async () => {
      resolveBob([{ id: "u3", username: "bob", displayName: "Bob", avatarUrl: null }]);
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: /bob/i })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops a pending account search when the helper kind changes", async () => {
    let resolveAli: (value: unknown[]) => void = () => {};
    mockSearchProfiles.mockImplementation(() => new Promise((resolve) => { resolveAli = resolve; }));
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /someone on findback/i }));
    fireEvent.change(screen.getByLabelText(/find the account/i), { target: { value: "ali" } });
    await waitFor(() => expect(mockSearchProfiles).toHaveBeenCalledWith("ali"));
    fireEvent.click(screen.getByRole("radio", { name: /someone outside findback/i }));
    // Switch back BEFORE the old request settles. The visible account branch
    // now owns an empty query; the old response must not publish anything.
    fireEvent.click(screen.getByRole("radio", { name: /someone on findback/i }));
    await act(async () => {
      resolveAli([{ id: "u2", username: "alice", displayName: "Alice Khan", avatarUrl: null }]);
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: /alice khan/i })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("No matching accounts.")).toBeNull();
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("does not announce an empty result before the search actually runs", async () => {
    mockSearchProfiles.mockResolvedValueOnce([]);
    renderSheet();
    fireEvent.click(screen.getByRole("radio", { name: /someone on findback/i }));
    fireEvent.change(screen.getByLabelText(/find the account/i), { target: { value: "ali" } });
    expect(screen.queryByText("No matching accounts.")).toBeNull();
    expect(screen.getByText("Searching…")).toBeTruthy();
    expect(await screen.findByText("No matching accounts.")).toBeTruthy();
  });
});
