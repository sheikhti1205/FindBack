// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { fireEvent } from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import { RouteTransition, resolveRouteVariants } from "./RouteTransition";
import { pageBackwardVariants, pageForwardVariants, pageVariants } from "./uiMotion";

afterEach(cleanup);

function renderAt(entry: string, extra?: React.ReactNode) {
  function GoDetail() {
    const navigate = useNavigate();
    return <button onClick={() => navigate("/posts/p1")}>open detail</button>;
  }
  function GoHome() {
    const navigate = useNavigate();
    return <button onClick={() => navigate("/")}>go home</button>;
  }
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<RouteTransition />}>
          <Route index element={<p>Home screen {extra}<GoDetail /></p>} />
          <Route path="/my" element={<p>My Reports screen</p>} />
          <Route path="/posts/:id" element={<p>Detail screen<GoHome /></p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("resolveRouteVariants", () => {
  it("slides forward when drilling into a detail page", () => {
    expect(resolveRouteVariants("/", "/posts/p1", "PUSH")).toBe(pageForwardVariants);
  });

  it("slides back when leaving a detail page", () => {
    expect(resolveRouteVariants("/posts/p1", "/", "POP")).toBe(pageBackwardVariants);
    expect(resolveRouteVariants("/posts/p1", "/", "PUSH")).toBe(pageBackwardVariants);
  });

  it("crossfades between major tabs", () => {
    expect(resolveRouteVariants("/", "/my", "PUSH")).toBe(pageVariants);
    expect(resolveRouteVariants("/my", "/profile", "PUSH")).toBe(pageVariants);
  });

  it("crossfades anything else by default", () => {
    expect(resolveRouteVariants("/search", "/report", "PUSH")).toBe(pageVariants);
  });
});

describe("RouteTransition", () => {
  it("renders routed content without losing it across a drill-down", () => {
    renderAt("/");
    expect(screen.getByText(/Home screen/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "open detail" }));
    // New route renders immediately — motion only accompanies navigation.
    // AnimatePresence keeps the exiting wrapper mounted for its exit, frozen
    // on the old screen, while the entering wrapper shows the new screen.
    expect(screen.getByText(/Detail screen/)).toBeTruthy();
    expect(screen.getByText(/Home screen/)).toBeTruthy();
    const wrappers = screen.getAllByTestId("route-transition");
    expect(wrappers.map((w) => w.getAttribute("data-route")).sort()).toEqual(["/", "/posts/p1"]);
  });

  it("stages exit/enter on the same route stage instead of stacking blocks", async () => {
    // jsdom reports zero element sizes, which makes PopChild skip the pop;
    // stub measured sizes so the real popLayout path executes.
    const origGetComputedStyle = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation(((el, pseudo) => {
      const styles = origGetComputedStyle(el, pseudo);
      return new Proxy(styles, {
        get: (target, prop, receiver) => {
          if (prop === "width") return "400px";
          if (prop === "height") return "800px";
          if (prop === "direction") return "ltr";
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof window.getComputedStyle);
    try {
      renderAt("/");
      fireEvent.click(screen.getByRole("button", { name: "open detail" }));
      const wrappers = screen.getAllByTestId("route-transition");
      expect(wrappers).toHaveLength(2);
      const exiting = wrappers.find((w) => w.getAttribute("data-route") === "/");
      const entering = wrappers.find((w) => w.getAttribute("data-route") === "/posts/p1");
      expect(exiting).toBeTruthy();
      expect(entering).toBeTruthy();
      // popLayout pops the exiting route out of normal flow (absolute via an
      // injected [data-motion-pop-id] rule) so both routes share one stage.
      await waitFor(() => expect(exiting!.hasAttribute("data-motion-pop-id")).toBe(true));
      // The entering route keeps the full-height contract so screens with
      // `flex h-full flex-col` internal scrollers (Home/Search/Help) still
      // resolve against a definite-height parent.
      expect(entering!.className).toMatch(/h-full/);
      expect(entering!.className).toMatch(/min-h-0/);
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps content rendered under forced reduced motion", () => {
    render(
      <MotionConfig reducedMotion="always">
        <MemoryRouter initialEntries={["/posts/p1"]}>
          <Routes>
            <Route element={<RouteTransition />}>
              <Route path="/posts/:id" element={<p>Detail screen</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </MotionConfig>,
    );
    const region = screen.getByText(/Detail screen/);
    expect(region).toBeTruthy();
    // Content stays in the accessibility tree under reduced motion.
    expect(screen.getByTestId("route-transition").textContent).toContain("Detail screen");
  });

  it("renders the previous screen immediately on back navigation", () => {
    function GoBack() {
      const navigate = useNavigate();
      return <button onClick={() => navigate(-1)}>go back</button>;
    }
    render(
      <MemoryRouter initialEntries={["/", "/posts/p1"]} initialIndex={1}>
        <Routes>
          <Route element={<RouteTransition />}>
            <Route index element={<p>Home screen</p>} />
            <Route path="/posts/:id" element={<p>Detail screen<GoBack /></p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(/Detail screen/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "go back" }));
    // Back navigation is immediate: the previous screen renders at once and
    // the backward variants apply (leaving a detail page).
    expect(screen.getByText(/Home screen/)).toBeTruthy();
    expect(resolveRouteVariants("/posts/p1", "/", "POP")).toBe(pageBackwardVariants);
  });
});
