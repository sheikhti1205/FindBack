// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { MotionConfig } from "framer-motion";
import { Shell } from "./Shell";
import { resetBackInterceptors } from "./backNavigation";
import { APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE } from "../appearance";
import { COMPACT_MAX_PX } from "./responsive";
import { readFileSync } from "node:fs";

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
    // Route stage: the positioning context for popLayout-exited routes, so
    // exiting/entering route wrappers share one stage instead of stacking.
    expect(main.className).toMatch(/relative/);
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

describe("Shell adaptive navigation (owner ruling 4(e))", () => {
  const initialWidth = window.innerWidth;

  function storeNavLayout(navLayout: "bottom" | "rail") {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_APPEARANCE, navLayout }),
    );
  }

  function setWidth(width: number) {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  }

  /** A controllable `matchMedia`, so the width gate is exercised the way production uses it. */
  function stubMatchMedia(initialWide: boolean) {
    let matches = initialWide;
    const listeners = new Set<() => void>();
    const query = {
      get matches() {
        return matches;
      },
      media: "",
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;
    vi.stubGlobal("matchMedia", vi.fn(() => query));
    return (wide: boolean) => {
      matches = wide;
      for (const listener of listeners) listener();
    };
  }

  function navLayouts(): string[] {
    return screen
      .queryAllByRole("navigation", { name: "Primary" })
      .map((nav) => nav.getAttribute("data-layout") ?? "unknown");
  }

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: initialWidth });
  });

  it.each([320, 500, COMPACT_MAX_PX - 1])(
    "keeps the bottom bar at %ipx even when a rail is stored",
    (width) => {
      setWidth(width);
      storeNavLayout("rail");
      renderShell("/");
      const nav = screen.getByRole("navigation", { name: "Primary" });
      expect(nav.getAttribute("data-layout")).toBe("bottom");
      expect(document.querySelector(".fb-nav-rail")).toBeNull();
    },
  );

  it("renders the stored rail at the breakpoint", () => {
    setWidth(COMPACT_MAX_PX);
    storeNavLayout("rail");
    renderShell("/");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.getAttribute("data-layout")).toBe("rail");
    expect(document.querySelector(".fb-nav-slot")).toBeNull();
  });

  it("renders the stored bottom bar at the breakpoint", () => {
    setWidth(COMPACT_MAX_PX);
    storeNavLayout("bottom");
    renderShell("/");
    expect(navLayouts()).toEqual(["bottom"]);
  });

  it("follows a width change without a reload", async () => {
    setWidth(COMPACT_MAX_PX);
    const setWide = stubMatchMedia(false);
    storeNavLayout("rail");
    renderShell("/");
    expect(navLayouts()).toEqual(["bottom"]);

    act(() => setWide(true));
    await waitFor(() => expect(navLayouts()).toEqual(["rail"]));

    act(() => setWide(false));
    await waitFor(() => expect(navLayouts()).toEqual(["bottom"]));
  });

  it("flips rail↔bottom atomically: one nav, in its own flex context, from the first commit", () => {
    setWidth(800);
    storeNavLayout("rail");
    const setWide = stubMatchMedia(true);
    renderShell("/");
    expect(navLayouts()).toEqual(["rail"]);

    // Rail → bottom (rotation, or leaving a wide window). An exiting rail in
    // the new column container would paint a 104×320px column above <main>.
    act(() => setWide(false));
    expect(navLayouts()).toEqual(["bottom"]);
    expect(document.querySelector(".fb-nav-rail")).toBeNull();
    let main = screen.getByRole("main");
    let nav = screen.getByRole("navigation", { name: "Primary" });
    expect(main.parentElement?.className).toContain("flex-col");
    // In a column the bar is after <main>, so <main> owns the full width.
    expect(
      main.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(main.className).toContain("flex-1");

    // Bottom → rail. An exiting bar in the new row container would be a
    // ~300px max-content sibling and squeeze <main> for 150ms.
    act(() => setWide(true));
    expect(navLayouts()).toEqual(["rail"]);
    expect(document.querySelector(".fb-nav-slot")).toBeNull();
    main = screen.getByRole("main");
    nav = screen.getByRole("navigation", { name: "Primary" });
    expect(main.parentElement?.className).toContain("flex-row");
    expect(main.className).toContain("min-w-0");
    expect(
      nav.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the rail mounted while the keyboard is open, and hides only the bar", () => {
    setWidth(800);
    storeNavLayout("rail");
    const previous = window.visualViewport;
    const viewport = new EventTarget();
    Object.defineProperty(viewport, "height", {
      configurable: true,
      value: window.innerHeight,
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      renderShell("/");
      expect(navLayouts()).toEqual(["rail"]);
      Object.defineProperty(viewport, "height", {
        configurable: true,
        value: window.innerHeight - 240,
      });
      act(() => viewport.dispatchEvent(new Event("resize")));
      // The rail is beside the content, so the keyboard cannot cover it and
      // hiding it would only widen <main> by 6.5rem and back.
      expect(navLayouts()).toEqual(["rail"]);
    } finally {
      cleanup();
      Object.defineProperty(window, "visualViewport", { configurable: true, value: previous });
    }
  });

  it("hands focus to the same destination when the layout flips", () => {
    setWidth(800);
    storeNavLayout("rail");
    const setWide = stubMatchMedia(true);
    renderShell("/");
    const before = within(screen.getByRole("navigation", { name: "Primary" })).getByRole(
      "link",
      { name: "Notifications" },
    );
    before.focus();
    expect(document.activeElement).toBe(before);

    act(() => setWide(false));
    const after = within(screen.getByRole("navigation", { name: "Primary" })).getByRole(
      "link",
      { name: "Notifications" },
    );
    // The old node unmounted; focus must not be left on <body>.
    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
    expect((document.activeElement as HTMLElement).getAttribute("href")).toBe("/notifications");
  });

  it("keeps the rail's destinations, order, targets, names and active treatment", () => {
    setWidth(800);
    storeNavLayout("rail");
    renderShell("/my");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");
    // Top-to-bottom DOM order is also the visual and keyboard order.
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/report", "/", "/my", "/profile", "/notifications",
    ]);
    expect(
      links.map((link) => link.getAttribute("aria-label") ?? link.textContent?.trim()),
    ).toEqual(["Create report", "Home", "My Reports", "Profile", "Notifications"]);
    expect(
      links
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.textContent?.trim()),
    ).toEqual(["My Reports"]);
    // Same selected-pill treatment as the bar.
    expect(nav.querySelector(".fb-nav-active-bg")).toBeTruthy();
    expect(nav.querySelector(".fb-nav-label")).toBeTruthy();
  });

  it("takes layout space beside the content instead of overlaying it", () => {
    setWidth(800);
    storeNavLayout("rail");
    renderShell("/");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const main = screen.getByRole("main");
    expect(nav.className).not.toMatch(/fixed|absolute/);
    expect(nav.parentElement?.className).toContain("flex-row");
    // Rail first, content after it: the DOM order matches the visual order.
    expect(
      nav.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(main.className).toContain("min-w-0");
    expect(main.className).toContain("flex-1");
  });

  it.each([320, 600, 900])("never renders a drawer at %ipx", (width) => {
    setWidth(width);
    storeNavLayout("rail");
    renderShell("/");
    expect(document.querySelector('[class*="drawer"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /menu|drawer/i })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.className).not.toMatch(/fixed|absolute/);
  });

  it("hides the rail on chrome-free routes", () => {
    setWidth(800);
    storeNavLayout("rail");
    renderShell("/help");
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  it("hides the rail during fullscreen and restores it on exit", () => {
    setWidth(800);
    storeNavLayout("rail");
    renderShell("/");
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

  it("keeps every rail label under forced reduced motion", () => {
    setWidth(800);
    storeNavLayout("rail");
    render(
      <MotionConfig reducedMotion="always">
        <MemoryRouter initialEntries={["/"]}>
          <Routes><Route element={<Shell />}>
            <Route index element={<p>Home screen</p>} />
          </Route></Routes>
        </MemoryRouter>
      </MotionConfig>,
    );
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.getAttribute("data-layout")).toBe("rail");
    for (const label of ["Home", "My Reports", "Profile", "Notifications"]) {
      expect(within(nav).getByText(label)).toBeTruthy();
    }
  });

  it("pins the rail's geometry with computed styles, not source text", () => {
    // The stylesheet is injected into the test document so `getComputedStyle`
    // runs the real cascade: a later rule that overrode the width, the column
    // direction or the flex basis would change these values. (In the app,
    // Vite loads the same file; jsdom does not import CSS on its own.)
    const css = readFileSync("src/components/Shell.nav.css", "utf8");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    try {
      setWidth(800);
      storeNavLayout("rail");
      renderShell("/");
      const nav = screen.getByRole("navigation", { name: "Primary" });
      const rail = getComputedStyle(nav);
      expect(rail.display).toBe("flex");
      expect(rail.flexDirection).toBe("column");
      expect(rail.flexGrow).toBe("0");
      expect(rail.flexShrink).toBe("0");
      expect(rail.width).toBe("104px"); // 6.5rem at the default 16px root
      expect(rail.position).toBe("static");
      const item = getComputedStyle(
        within(nav).getByRole("link", { name: "My Reports" }),
      );
      expect(item.minHeight).toBe("56px");
      expect(item.flexDirection).toBe("column");
    } finally {
      style.remove();
    }
  });
});
