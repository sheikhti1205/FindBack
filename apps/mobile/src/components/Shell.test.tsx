// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { MotionConfig } from "framer-motion";
import { Shell } from "./Shell";
import { resetBackInterceptors } from "./backNavigation";

afterEach(() => { cleanup(); resetBackInterceptors(); document.body.style.overflow = ""; });

function renderShell(entry = "/") {
  function GoBack() {
    const navigate = useNavigate();
    return <button onClick={() => navigate(-1)}>Back</button>;
  }
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <GoBack />
      <Routes><Route element={<Shell />}>
        <Route index element={<p>Home screen</p>} />
        <Route path="/search" element={<p>Search screen</p>} />
        <Route path="/my" element={<p>My Reports screen</p>} />
        <Route path="/profile" element={<p>Profile screen</p>} />
        <Route path="/notifications" element={<p>Notifications screen</p>} />
        <Route path="/report" element={<p>Report screen</p>} />
        <Route path="/ai-connection" element={<p>AI connection</p>} />
      </Route></Routes>
    </MemoryRouter>,
  );
}

describe("Shell floating primary navigation", () => {
  it("offers four destinations and a separate create action", () => {
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("link").map((t) => t.getAttribute("href"))).toEqual([
      "/", "/my", "/profile", "/notifications", "/report",
    ]);
    expect(within(nav).getByRole("link", { name: "Create report" })).toBeTruthy();
    expect(screen.queryByTestId("assistant-entry")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open assistant" })).toBeNull();
  });

  it.each([
    ["/", "Home"], ["/search", "Home"], ["/my", "My Reports"],
    ["/profile", "Profile"], ["/notifications", "Notifications"],
  ])("selects only %s's destination with a visible label", (path, label) => {
    renderShell(path);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");
    expect(links.filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.getAttribute("aria-label") ?? link.textContent)).toEqual([label]);
    expect(within(nav).getByText(label).getAttribute("aria-hidden")).not.toBe("true");
    expect(links.slice(0, 4).filter((link) => link.textContent?.trim()).map((link) => link.textContent?.trim())).toEqual([label]);
  });

  it("tracks URL after navigation and Back rather than a stale local selection", () => {
    renderShell("/my");
    fireEvent.click(screen.getByRole("link", { name: "Notifications" }));
    expect(screen.getByRole("link", { name: "Notifications" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("link", { name: "My Reports" }).getAttribute("aria-current")).toBe("page");
  });

  it("leaves all tabs unselected on /report while keeping the create action available", () => {
    renderShell("/report");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("link").every((link) => !link.hasAttribute("aria-current"))).toBe(true);
    expect(within(nav).getByRole("link", { name: "Create report" }).getAttribute("href")).toBe("/report");
  });

  it("does not expose a scrolling-hide action and keeps the primary links named", () => {
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).not.toContain("translate-y-full");
    expect(within(nav).getAllByRole("link").map((link) => link.getAttribute("aria-label") ?? link.textContent)).toEqual([
      "Home", "My Reports", "Profile", "Notifications", "Create report",
    ]);
  });

  it.each([320, 360, 393, 420])("retains all five named actions at %ipx", (width) => {
    const previous = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    try {
      renderShell("/notifications");
      expect(within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("link")).toHaveLength(5);
      expect(screen.getByRole("link", { name: "Notifications" }).textContent).toBe("Notifications");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: previous });
    }
  });

  it("hides navigation when the visual viewport is occupied by the keyboard", () => {
    const previous = window.visualViewport;
    const viewport = new EventTarget();
    Object.defineProperty(viewport, "height", { configurable: true, value: window.innerHeight });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      renderShell();
      expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
      Object.defineProperty(viewport, "height", { configurable: true, value: window.innerHeight - 240 });
      act(() => viewport.dispatchEvent(new Event("resize")));
      expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
      Object.defineProperty(viewport, "height", { configurable: true, value: window.innerHeight });
      act(() => viewport.dispatchEvent(new Event("resize")));
      expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
    } finally {
      cleanup();
      Object.defineProperty(window, "visualViewport", { configurable: true, value: previous });
    }
  });

  it("keeps a visible label and animated selection pill on press (always animated)", () => {
    // Production always animates: no MotionConfig reducedMotion wrapper.
    renderShell();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const create = within(nav).getByRole("link", { name: "Create report" });
    fireEvent.pointerDown(create);
    // The selected destination renders the animated active pill + label.
    expect(nav.querySelector(".fb-nav-active-bg")).toBeTruthy();
    expect(nav.querySelector(".fb-nav-label")).toBeTruthy();
    expect(within(nav).getByText("Home")).toBeTruthy();
  });

  it("hides the bottom nav on AI connection and shows no assistant UI", () => {
    renderShell("/ai-connection");
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    expect(screen.queryByTestId("assistant-entry")).toBeNull();
  });

  it.each(["/help", "/posts/example"])('keeps chrome hidden on %s', (path) => {
    renderShell(path);
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  it("removes nav during fullscreen and restores it on exit", () => {
    renderShell();
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.body });
    try {
      act(() => document.dispatchEvent(new Event("fullscreenchange")));
      expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    } finally {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
      act(() => document.dispatchEvent(new Event("fullscreenchange")));
    }
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
  });
});

describe("Shell P1 viewport (screenshots 08/11/12)", () => {
  function renderShellAt(entry: string) {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes><Route element={<Shell />}>
          <Route index element={<p>Home screen</p>} />
          <Route path="/search" element={<p>Search screen</p>} />
          <Route path="/help" element={<p>Assistant screen</p>} />
          <Route path="/ai-connection" element={<p>AI connection</p>} />
        </Route></Routes>
      </MemoryRouter>,
    );
  }

  it("owns one app viewport with no phantom bottom padding on /help", () => {
    renderShellAt("/help");
    // Full-screen Assistant takes the whole viewport: no tab bar, no tab pad.
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    const viewport = document.querySelector(".fb-app-viewport");
    expect(viewport).toBeTruthy();
    const main = screen.getByRole("main");
    expect(main.className).not.toMatch(/pb-20/);
    expect(main.className).toMatch(/min-h-0/);
    expect(main.className).toMatch(/flex-1/);
  });

  it("keeps the bottom nav in normal flex flow, not a fixed overlay", () => {
    renderShellAt("/");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).not.toMatch(/fixed/);
  });
});

describe("Shell nav hide/show with focusability (Wave A)", () => {
  function renderShellWithDetail(entry: string) {
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
        <Routes><Route element={<Shell />}>
          <Route index element={<p>Home screen<GoDetail /></p>} />
          <Route path="/posts/:id" element={<p>Detail screen<GoHome /></p>} />
          <Route path="/help" element={<p>Help screen<GoHome /></p>} />
        </Route></Routes>
      </MemoryRouter>,
    );
  }

  it("detail route shows content with no focusable nav chrome", async () => {
    renderShellWithDetail("/posts/p1");
    expect(screen.getByText(/Detail screen/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull());
    // Hidden nav unmounts: no tab stops or labelled links leak.
    expect(document.querySelector(".fb-nav-slot")).toBeNull();
    expect(screen.queryByRole("link", { name: "Create report" })).toBeNull();
  });

  it("navigating detail → home restores the nav without losing content", async () => {
    renderShellWithDetail("/posts/p1");
    fireEvent.click(screen.getByRole("button", { name: "go home" }));
    // Navigation is immediate: new content renders at once...
    expect(screen.getByText(/Home screen/)).toBeTruthy();
    // ...and the nav returns to the tab order.
    expect(await screen.findByRole("navigation", { name: "Primary" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create report" })).toBeTruthy();
  });

  it("navigating home → detail swaps content immediately and the nav exits", async () => {
    renderShellWithDetail("/");
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "open detail" }));
    // Motion only accompanies navigation: the new screen is there at once.
    expect(screen.getByText(/Detail screen/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull());
  });

  it("labels still appear under forced reduced motion", () => {
    render(
      <MotionConfig reducedMotion="always">
        <MemoryRouter initialEntries={["/"]}>
          <Routes><Route element={<Shell />}>
            <Route index element={<p>Home screen</p>} />
          </Route></Routes>
        </MemoryRouter>
      </MotionConfig>,
    );
    // The pill may snap, but the selected label must still render.
    expect(screen.getByText("Home")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
  });
});
