// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Profiler, createRef } from "react";
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

describe("PullToRefresh — no state per touch move", () => {
  it("commits at most twice per gesture; the visual pull is frame-driven, not setState-driven", async () => {
    let commits = 0;
    const { container } = render(
      <Profiler
        id="ptr-gesture"
        onRender={() => {
          commits += 1;
        }}
      >
        <PullToRefresh onRefresh={pendingRefresh()}>
          <div>feed</div>
        </PullToRefresh>
      </Profiler>,
    );
    const el = container.firstElementChild!;
    commits = 0;

    // Ten separate frames of finger movement, like real touch delivery.
    act(() => {
      fireEvent.touchStart(el, { touches: [pt(20, 20)] });
    });
    for (let n = 1; n <= 10; n += 1) {
      act(() => {
        fireEvent.touchMove(el, { touches: [pt(20, 20 + n * 10)] });
      });
    }
    // Let any scheduled frame callbacks run.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Gesture start only — never one React commit per move event.
    expect(commits).toBeLessThanOrEqual(2);
    // …yet the pill still tracks the finger through the DOM.
    const pill = screen.getByTestId("refresh-pill") as HTMLElement;
    expect(pill.style.opacity).toBe("1");
    expect(pill.style.transform).toContain("scale(");

    // Below-threshold release: no refresh, pill snaps back.
    act(() => {
      fireEvent.touchEnd(el);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("PullToRefresh — capsule-only indicator, list never moves", () => {
  it("reveals only a Morph capsule while pulling: no visible text, zero-height slot", async () => {
    const { container } = render(
      <PullToRefresh onRefresh={pendingRefresh()}>
        <ul data-testid="feed">
          <li>Lost keys</li>
        </ul>
      </PullToRefresh>,
    );
    const el = container.firstElementChild!;
    const flush = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

    // Below threshold: the pull is tracked, the list does not move.
    act(() => {
      fireEvent.touchStart(el, { touches: [pt(20, 20)] });
      fireEvent.touchMove(el, { touches: [pt(20, 120)] });
    });
    await flush();

    const status = screen.getByRole("status");
    // Zero-height sticky slot: the list is never pushed down.
    expect(status.className).toMatch(/h-0/);
    // The only text is visually hidden (screen-reader position only).
    const pill = screen.getByTestId("refresh-pill");
    const hidden = pill.querySelector(".sr-only");
    expect(hidden?.textContent).toMatch(/pull to refresh/i);
    expect(status.textContent).toBe(hidden?.textContent);
    // …and the visible affordance is the Morph bar inside the capsule: no
    // rotating glyph anywhere, and the bar stretches with the finger.
    const bar = pill.querySelector('[data-testid="refresh-bar"]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(pill.querySelector("svg")).toBeNull();
    const shortWidth = parseFloat(bar.style.width);
    // The feed stays mounted, same nodes, underneath.
    expect(screen.getByText("Lost keys")).toBeTruthy();

    // Past the threshold the accessible name advances — still capsule-only.
    act(() => {
      fireEvent.touchMove(el, { touches: [pt(20, 260)] });
    });
    await flush();
    expect(pill.querySelector(".sr-only")?.textContent).toMatch(/release to refresh/i);
    const stretched = screen.getByTestId("refresh-bar") as HTMLElement;
    // Stretched capsule: pulling widens the bar instead of spinning a glyph.
    expect(parseFloat(stretched.style.width)).toBeGreaterThan(shortWidth);
  });

  it("keeps the Morph capsule on the indicator for the whole request", async () => {
    const { container } = render(
      <PullToRefresh onRefresh={pendingRefresh()}>
        <div data-testid="feed">Lost keys</div>
      </PullToRefresh>,
    );
    const el = container.firstElementChild!;
    const before = screen.getByText("Lost keys");

    act(() => {
      pull(el);
    });
    act(() => {
      fireEvent.touchEnd(el);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Still refreshing: the capsule persists with the morph, the list intact.
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-label")).toBe("Refreshing");
    const bar = screen.getByTestId("refresh-bar");
    expect(bar.getAttribute("data-animated")).toBe("true");
    expect(bar.className).toContain("fb-morph-bar");
    expect(screen.getByTestId("refresh-pill").querySelector("svg")).toBeNull();
    expect(screen.getByText("Lost keys")).toBe(before);
  });

  it("holds the bar still (no travel, no morph) when motion is reduced", async () => {
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
      const { container } = render(
        <PullToRefresh onRefresh={pendingRefresh()}>
          <div data-testid="feed">Lost keys</div>
        </PullToRefresh>,
      );
      const el = container.firstElementChild!;

      act(() => {
        pull(el);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // The finger still stretches the bar (that is the gesture being echoed,
      // not an autonomous animation) …
      const bar = screen.getByTestId("refresh-bar");
      expect(bar.getAttribute("data-animated")).toBe("false");
      expect(bar.className).not.toContain("fb-morph-bar");
      expect(bar.style.width).not.toBe("");

      act(() => {
        fireEvent.touchEnd(el);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // …but nothing morphs once the app owns the wait: a static capsule.
      const still = screen.getByTestId("refresh-bar");
      expect(still.getAttribute("data-animated")).toBe("false");
      expect(still.className).not.toContain("fb-morph-bar");
      expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Refreshing");
    } finally {
      window.matchMedia = originalMatchMedia;
    }
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
