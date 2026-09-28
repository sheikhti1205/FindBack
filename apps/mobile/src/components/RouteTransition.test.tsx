// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
