// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { PullToRefresh, type PullToRefreshHandle } from "./PullToRefresh";

// vitest runs without `globals`, so RTL's auto-cleanup never registers.
afterEach(() => {
  cleanup();
});

type Pt = { clientX: number; clientY: number };
const pt = (clientX: number, clientY: number): Pt => ({ clientX, clientY });

/** Vertical pull that crosses the 64px threshold (240px * 0.45 = 108px dampened). */
function pull(el: Element) {
  fireEvent.touchStart(el, { touches: [pt(20, 20)] });
  fireEvent.touchMove(el, { touches: [pt(20, 260)] });
}

/** A refresh that never settles — keeps `refreshing` true for the assertion. */
const pendingRefresh = () => vi.fn(() => new Promise<void>(() => {}));

describe("PullToRefresh scroll handle", () => {
  it("exposes a writable scrollTop for feed back-nav restore", () => {
    const ref = createRef<PullToRefreshHandle>();
    render(
      <PullToRefresh ref={ref} onRefresh={vi.fn()}>
        <div style={{ height: 2000 }}>tall</div>
      </PullToRefresh>,
    );
    ref.current!.scrollTop = 350;
    expect(ref.current!.scrollTop).toBe(350);
  });
});

describe("PullToRefresh — exactly one refresh per release", () => {
  it("fires once when the same release is delivered twice", () => {
    const onRefresh = pendingRefresh();
    const { container } = render(
      <PullToRefresh onRefresh={onRefresh}>
        <div>feed</div>
      </PullToRefresh>,
    );
    const el = container.firstElementChild!;

    // Commit the pull first so the release is evaluated against real state.
    act(() => {
      pull(el);
    });
    act(() => {
      // Gesture + settle: the release reaches the handler more than once
      // (second finger lifting, or a duplicate delivery in the same batch).
      fireEvent.touchEnd(el);
      fireEvent.touchEnd(el);
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not start a second refresh when a release arrives while one is already running", () => {
    const onRefresh = pendingRefresh();
    const { container, rerender } = render(
      <PullToRefresh onRefresh={onRefresh}>
        <div>feed</div>
      </PullToRefresh>,
    );
    const el = container.firstElementChild!;

    // The user starts pulling at scrollTop 0.
    act(() => {
      pull(el);
    });

    // A background refresh starts meanwhile (tab tap / realtime), so the parent
    // disables the control — exactly what Home does with
    // `disabled={loading || refreshing}`.
    rerender(
      <PullToRefresh onRefresh={onRefresh} disabled>
        <div>feed</div>
      </PullToRefresh>,
    );

    act(() => {
      fireEvent.touchEnd(el);
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("does not refresh from a gesture the browser cancelled, then a plain tap-release", () => {
    const onRefresh = pendingRefresh();
    const { container } = render(
      <PullToRefresh onRefresh={onRefresh}>
        <div>feed</div>
      </PullToRefresh>,
    );
    const el = container.firstElementChild!;

    act(() => {
      pull(el);
      // The browser aborts the gesture (nested scroller / system takeover).
      fireEvent.touchCancel(el);
    });

    // Later: an ordinary tap on the feed — no pull at all.
    act(() => {
      fireEvent.touchStart(el, { touches: [pt(20, 20)] });
      fireEvent.touchEnd(el);
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe("PullToRefresh — feed stays visible while refreshing", () => {
  it("keeps the previously rendered items mounted for the whole refresh", async () => {
    let settleRefresh!: () => void;
    const onRefresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleRefresh = resolve;
        }),
    );
    const { container } = render(
      <PullToRefresh onRefresh={onRefresh}>
        <ul data-testid="feed">
          <li>Lost keys</li>
          <li>Found wallet</li>
        </ul>
      </PullToRefresh>,
    );
    const el = container.firstElementChild!;
    const keysBefore = screen.getByText("Lost keys");

    act(() => {
      pull(el);
    });
    act(() => {
      fireEvent.touchEnd(el);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Slow network: refresh in flight — same nodes, still on screen, no empty flash.
    expect(screen.getByTestId("feed")).toBeTruthy();
    expect(screen.getByText("Lost keys")).toBe(keysBefore);
    expect(screen.getByText("Found wallet")).toBeTruthy();

    await act(async () => {
      settleRefresh();
      await Promise.resolve();
    });

    expect(screen.getByText("Lost keys")).toBe(keysBefore);
    expect(screen.getByText("Found wallet")).toBeTruthy();
  });
});

describe("PullToRefresh — nested horizontal scroller", () => {
  it("does not trigger the vertical refresh from a horizontal category-rail swipe", () => {
    const onRefresh = pendingRefresh();
    render(
      <PullToRefresh onRefresh={onRefresh}>
        <div data-testid="feed">feed</div>
        <div data-testid="rail" style={{ overflowX: "auto" }}>
          <span>Cats</span>
          <span>Keys</span>
          <span>Wallet</span>
        </div>
      </PullToRefresh>,
    );
    const rail = screen.getByTestId("rail");

    act(() => {
      fireEvent.touchStart(rail, { touches: [pt(30, 30)] });
      // Ambiguous opener: both deltas under 10px.
      fireEvent.touchMove(rail, { touches: [pt(34, 35)] });
      // Clearly horizontal from here on…
      fireEvent.touchMove(rail, { touches: [pt(150, 70)] });
      // …the rail scrolls 360px while the finger drifts 150px down.
      fireEvent.touchMove(rail, { touches: [pt(390, 180)] });
    });
    act(() => {
      fireEvent.touchEnd(rail);
    });

    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe("PullToRefresh — failing refresh", () => {
  it("keeps the previous items and shows an honest error/retry state", async () => {
    const onRefresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce(undefined);
    const { container } = render(
      <PullToRefresh onRefresh={onRefresh}>
        <div data-testid="feed">Lost keys</div>
      </PullToRefresh>,
    );
    const el = container.firstElementChild!;

    act(() => {
      pull(el);
    });
    act(() => {
      fireEvent.touchEnd(el);
    });

    // Honest failure state: the component must not pretend the refresh worked.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toMatch(/network|connection|try again/i);
    // Previous items intact.
    expect(screen.getByTestId("feed")).toBeTruthy();
    expect(screen.getByText("Lost keys")).toBeTruthy();

    // Retry re-runs the refresh and clears the failure once it succeeds.
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("Lost keys")).toBeTruthy();
  });
});
