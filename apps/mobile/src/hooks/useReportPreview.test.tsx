// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostItem } from "@findback/shared";

const { fetchPost } = vi.hoisted(() => ({ fetchPost: vi.fn() }));
vi.mock("../services/posts", () => ({ fetchPost }));

import { ReportPreviewProvider } from "../components/CommentReportPreviews";
import { useReportPreview } from "./useReportPreview";
import { ApiError } from "../services/session";

function post(id: string, title = `title ${id}`): PostItem {
  return {
    id,
    userId: "u2",
    author: {
      id: "u2",
      username: "owner",
      displayName: null,
      avatarUrl: null,
      emailVerified: false,
      phoneVerified: false,
      createdAt: "2026-01-02T00:00:00.000Z",
    },
    type: "FOUND",
    title,
    description: "",
    category: "Electronics",
    status: "OPEN",
    eventDate: "2026-09-01",
    latitude: null,
    longitude: null,
    locationLabel: null,
    youtubeUrl: null,
    attachments: [],
    likeCount: 0,
    dislikeCount: 0,
    ratingAvg: null,
    ratingCount: 0,
    commentCount: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

function Probe({ postId, label }: { postId: string | null; label: string }) {
  const state = useReportPreview(postId);
  return (
    <span data-testid={label}>
      {state.status}
      {state.status === "ready" ? `:${state.post.title}` : ""}
    </span>
  );
}

function renderInProvider(ui: ReactNode, resetKey = "u1") {
  return render(<ReportPreviewProvider resetKey={resetKey}>{ui}</ReportPreviewProvider>);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  fetchPost.mockReset();
});

describe("useReportPreview", () => {
  it("short-circuits a tombstone (null pointer) without a network call", () => {
    renderInProvider(<Probe postId={null} label="a" />);
    expect(screen.getByTestId("a").textContent).toBe("unavailable");
    expect(fetchPost).not.toHaveBeenCalled();
  });

  it("resolves a readable reference to its post", async () => {
    fetchPost.mockResolvedValue(post("r1", "Blue bike"));
    renderInProvider(<Probe postId="r1" label="a" />);
    expect(screen.getByTestId("a").textContent).toBe("loading");
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("ready:Blue bike"));
  });

  it("collapses NOT_FOUND to the same unavailable state as the tombstone", async () => {
    fetchPost.mockRejectedValue(new ApiError("Post not found", 404));
    renderInProvider(<Probe postId="gone" label="a" />);
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("unavailable"));
  });

  it("reads each distinct id once: N references, M ids, exactly M calls", async () => {
    fetchPost.mockImplementation((id: string) => Promise.resolve(post(id)));
    renderInProvider(
      <>
        <Probe postId="r1" label="a" />
        <Probe postId="r2" label="b" />
        <Probe postId="r1" label="c" />
        <Probe postId="r2" label="d" />
        <Probe postId="r2" label="e" />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("e").textContent).toBe("ready:title r2"));
    expect(fetchPost).toHaveBeenCalledTimes(2);
    expect(fetchPost.mock.calls.map(([id]) => id).sort()).toEqual(["r1", "r2"]);
  });

  it("reuses an in-flight read for a concurrent render instead of double-calling", async () => {
    const first = deferred<PostItem>();
    fetchPost.mockReturnValueOnce(first.promise);
    const view = renderInProvider(<Probe postId="r1" label="a" />);
    expect(fetchPost).toHaveBeenCalledTimes(1);

    // A second comment referencing the same id arrives before the first read
    // settles. The in-flight entry is recorded synchronously, so it is reused.
    view.rerender(
      <ReportPreviewProvider resetKey="u1">
        <Probe postId="r1" label="a" />
        <Probe postId="r1" label="b" />
      </ReportPreviewProvider>,
    );
    expect(fetchPost).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve(post("r1", "Blue bike")));
    expect(screen.getByTestId("b").textContent).toBe("ready:Blue bike");
  });

  it("drops the map on a list refetch and reads a fresh M", async () => {
    fetchPost.mockImplementation((id: string) => Promise.resolve(post(id)));
    const view = renderInProvider(
      <>
        <Probe postId="r1" label="a" />
        <Probe postId="r2" label="b" />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("b").textContent).toBe("ready:title r2"));
    expect(fetchPost).toHaveBeenCalledTimes(2);

    // Refetch: the list generation changes, so the provider starts a fresh map.
    view.rerender(
      <ReportPreviewProvider resetKey="u1:2">
        <Probe postId="r1" label="a" />
        <Probe postId="r2" label="b" />
      </ReportPreviewProvider>,
    );
    await waitFor(() => expect(fetchPost).toHaveBeenCalledTimes(4));
  });

  it("does not deliver a previous account's payload or suppress the new account's read", async () => {
    const oldAccount = deferred<PostItem>();
    const newAccount = deferred<PostItem>();
    fetchPost.mockReturnValueOnce(oldAccount.promise).mockReturnValueOnce(newAccount.promise);

    const view = renderInProvider(<Probe postId="r1" label="a" />, "u1");
    expect(fetchPost).toHaveBeenCalledTimes(1);

    // Account switch while the first read is in flight.
    view.rerender(
      <ReportPreviewProvider resetKey="u2">
        <Probe postId="r1" label="a" />
      </ReportPreviewProvider>,
    );
    expect(fetchPost).toHaveBeenCalledTimes(2);

    // The old account's late payload must not reach the new account's card.
    await act(async () => oldAccount.resolve(post("r1", "old account payload")));
    expect(screen.getByTestId("a").textContent).toBe("loading");
    expect(screen.queryByText(/old account payload/)).toBeNull();

    await act(async () => newAccount.resolve(post("r1", "new account payload")));
    expect(screen.getByTestId("a").textContent).toBe("ready:new account payload");
  });
});

function RetryProbe({ postId, label }: { postId: string; label: string }) {
  const state = useReportPreview(postId);
  return (
    <span data-testid={label}>
      {state.status}
      {state.status === "ready" ? `:${state.post.title}` : ""}
      {state.status === "error" ? (
        <button type="button" onClick={state.retry}>
          Retry
        </button>
      ) : null}
    </span>
  );
}

describe("useReportPreview error retry", () => {
  it("re-reads after a transport failure", async () => {
    fetchPost.mockRejectedValueOnce(new ApiError("Server error", 400));
    renderInProvider(<RetryProbe postId="r1" label="a" />);
    await waitFor(() => expect(screen.getByTestId("a").textContent).toContain("error"));

    fetchPost.mockResolvedValueOnce(post("r1", "Blue bike"));
    await act(async () => screen.getByRole("button", { name: "Retry" }).click());
    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("ready:Blue bike"));
    expect(fetchPost).toHaveBeenCalledTimes(2);
  });
});
