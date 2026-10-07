// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_STORAGE_KEY } from "../services/onboarding";
import { Onboarding } from "./Onboarding";

let reduceMotion = false;

// Installed at module scope — before the first render — because the shared
// motion hooks read matchMedia on mount.
window.matchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: query.includes("prefers-reduced-motion") ? reduceMotion : false,
  media: query,
  onchange: null,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
  dispatchEvent: vi.fn(),
})) as unknown as typeof window.matchMedia;

beforeEach(() => {
  reduceMotion = false;
  localStorage.clear();
});

afterEach(cleanup);

function goToLastPage() {
  fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
  fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
}

describe("Onboarding first run", () => {
  it("fresh launch shows the first page with progress announced", () => {
    render(<Onboarding />);
    expect(screen.getByRole("heading", { level: 1, name: /lose less\. find faster\./i })).toBeTruthy();
    expect(
      screen.getByText(/report a lost or found item and keep every update in one place\./i),
    ).toBeTruthy();
    const progress = screen.getByRole("progressbar", { name: /onboarding progress/i });
    expect(progress.textContent).toMatch(/1 of 4/);
    expect(progress.getAttribute("aria-valuenow")).toBe("1");
    // Exactly one h1 per page.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("Next walks through all four exact pages; Back returns", () => {
    render(<Onboarding />);
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByRole("heading", { level: 1, name: /report in seconds\./i })).toBeTruthy();
    expect(
      screen.getByText(/you stay in control before anything is posted\./i),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    expect(
      screen.getByRole("heading", { level: 1, name: /useful matches\. privacy first\./i }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(screen.getByRole("heading", { level: 1, name: /report in seconds\./i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByRole("heading", { level: 1, name: /set it up your way\./i })).toBeTruthy();
    expect(
      screen.getByText(/choose your theme, notifications and optional ai tools whenever you want\./i),
    ).toBeTruthy();
  });

  it("shows Skip on pages 1-3 only, Back on 2-4 only, Get started on page 4 only", () => {
    render(<Onboarding />);
    expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^skip$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^next$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /get started/i })).toBeNull();

    goToLastPage();
    expect(screen.queryByRole("button", { name: /^skip$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^next$/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^back$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /get started/i })).toBeTruthy();
  });

  it("Skip persists completion and notifies the host", () => {
    const onComplete = vi.fn();
    render(<Onboarding onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("2");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("Get started persists completion and notifies the host", () => {
    const onComplete = vi.fn();
    render(<Onboarding onComplete={onComplete} />);
    goToLastPage();
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("2");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("replay keeps completion (finishing again never clears it)", () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "2");
    const onComplete = vi.fn();
    render(<Onboarding onComplete={onComplete} />);
    // Mounting a replay must not clear completion.
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("2");
    goToLastPage();
    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe("2");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("never displays a fake match probability", () => {
    render(<Onboarding initialPage={2} />);
    expect(document.body.textContent).not.toMatch(/%/);
    expect(document.body.textContent).not.toMatch(/\b\d+\s*percent\b/i);
  });

  it("decorative illustrations stay hidden from assistive tech", () => {
    render(<Onboarding />);
    const art = document.querySelector("[data-onboarding-art]");
    expect(art).toBeTruthy();
    expect(art?.getAttribute("aria-hidden")).toBe("true");
  });

  it("full keyboard operability: native buttons plus arrow-key paging", () => {
    render(<Onboarding />);
    const next = screen.getByRole("button", { name: /^next$/i });
    const skip = screen.getByRole("button", { name: /^skip$/i });
    expect(next.tagName).toBe("BUTTON");
    expect(skip.tagName).toBe("BUTTON");

    next.focus();
    expect(document.activeElement).toBe(next);
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { level: 1, name: /report in seconds\./i })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("region", { name: /onboarding/i }), { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { level: 1, name: /lose less\. find faster\./i })).toBeTruthy();
  });

  it("does not overflow horizontally at Extra-large text", () => {
    render(<Onboarding />);
    const root = screen.getByRole("region", { name: /onboarding/i });
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
    expect(root.className).toMatch(/fb-onboarding/);
  });

  it("reduced motion renders the static illustration variant without travel", () => {
    reduceMotion = true;
    render(<Onboarding />);
    const root = screen.getByRole("region", { name: /onboarding/i });
    expect(root.getAttribute("data-motion")).toBe("static");
    const art = document.querySelector("[data-onboarding-art]");
    expect(art?.getAttribute("data-motion")).toBe("static");
  });

  it("full motion marks the animated variant", () => {
    render(<Onboarding />);
    expect(screen.getByRole("region", { name: /onboarding/i }).getAttribute("data-motion")).toBe(
      "full",
    );
  });
});

describe("Onboarding viewport ownership (V1-UI-001)", () => {
  it("owns full viewport height outside Shell and pins controls reachable", async () => {
    // Static contract on the authoritative owner: Onboarding renders outside
    // Shell (no .fb-app-viewport), so .fb-onboarding must declare its own
    // min-height in dvh (with a vh fallback) and bottom-pinned controls.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const css = readFileSync(join(process.cwd(), "src/screens/Onboarding.css"), "utf8");
    const rootRule = /\.fb-onboarding\s*\{[^}]*\}/s.exec(css)?.[0] ?? "";
    expect(rootRule).toMatch(/min-height:\s*100vh/);
    expect(rootRule).toMatch(/min-height:\s*100dvh/);
    // min-height (never height): short screens and large text must grow and
    // scroll instead of clipping.
    expect(rootRule).not.toMatch(/(?<!min-)height:\s*100/);
    const controlsRule = /\.fb-onboarding-controls\s*\{[^}]*\}/s.exec(css)?.[0] ?? "";
    expect(controlsRule).toMatch(/margin-top:\s*auto/);
  });
});
