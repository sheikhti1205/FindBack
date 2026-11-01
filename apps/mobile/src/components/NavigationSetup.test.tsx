// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavigationSetup } from "./NavigationSetup";
import { APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE, loadAppearance, saveAppearance } from "../appearance";
import { useNavLayout } from "./navLayout";

function Harness() { const layout = useNavLayout(); return <><NavigationSetup /><output aria-label="Resolved navigation">{layout}</output></>; }
function width(value: number) { Object.defineProperty(window, "innerWidth", { configurable: true, value }); }
let pointer = true;
beforeEach(() => { localStorage.clear(); width(1200); pointer = true; vi.stubGlobal("matchMedia", (q: string) => ({ get matches() { return q.includes("pointer: fine") ? pointer : q.includes("min-width: 600px") && window.innerWidth >= 600; }, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
describe("first use device navigation choice", () => {
  it.each([320, 393, 599, 768])("does not ask on compact or small tablet %spx, without acknowledging a choice", value => {
    width(value); render(<Harness />);
    expect(screen.queryByRole("region", { name: "Choose your navigation" })).toBeNull();
    expect(screen.getByLabelText("Resolved navigation").textContent).toBe("bottom");
    expect(loadAppearance().navLayoutChosen).toBe(false);
  });
  it.each([true, false])("wide first use offers all actions; recommended follows fine pointer=%s", fine => {
    pointer = fine; render(<Harness />);
    expect(screen.getByRole("region", { name: "Choose your navigation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Side rail/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Bottom navigation/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Use recommended/ }));
    expect(loadAppearance()).toMatchObject({ navLayout: fine ? "rail" : "bottom", navLayoutChosen: true });
    expect(screen.queryByRole("region", { name: "Choose your navigation" })).toBeNull();
    expect(screen.getByLabelText("Resolved navigation").textContent).toBe(fine ? "rail" : "bottom");
  });
  it("explicit bottom overrides a fine-pointer recommendation and persists across remounts", () => {
    const first = render(<Harness />); fireEvent.click(screen.getByRole("button", { name: /Bottom navigation/ }));
    first.unmount(); render(<Harness />);
    expect(screen.queryByRole("region", { name: "Choose your navigation" })).toBeNull();
    expect(screen.getByLabelText("Resolved navigation").textContent).toBe("bottom");
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!)).toMatchObject({ navLayoutChosen: true });
  });
  it("explicit rail survives phone resize and reappears as rail when wide again", () => {
    render(<Harness />); fireEvent.click(screen.getByRole("button", { name: /Side rail/ }));
    act(() => { width(393); window.dispatchEvent(new Event("resize")); });
    expect(screen.getByLabelText("Resolved navigation").textContent).toBe("bottom");
    act(() => { width(1200); window.dispatchEvent(new Event("resize")); });
    expect(screen.getByLabelText("Resolved navigation").textContent).toBe("rail");
    expect(screen.queryByRole("region", { name: "Choose your navigation" })).toBeNull();
  });
  it("does not erase a legacy explicit preference or a later Appearance choice", () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ navLayout: "rail" }));
    const first = render(<Harness />);
    expect(screen.queryByRole("region", { name: "Choose your navigation" })).toBeNull();
    first.unmount(); localStorage.clear(); render(<Harness />);
    act(() => saveAppearance({ ...DEFAULT_APPEARANCE, navLayout: "bottom", navLayoutChosen: true }));
    expect(screen.queryByRole("region", { name: "Choose your navigation" })).toBeNull();
  });
  it("hides when narrowed without silently accepting and offers again when expanded", () => {
    render(<Harness />);
    act(() => { width(393); window.dispatchEvent(new Event("resize")); });
    expect(screen.queryByRole("region", { name: "Choose your navigation" })).toBeNull();
    expect(loadAppearance().navLayoutChosen).toBe(false);
    act(() => { width(840); window.dispatchEvent(new Event("resize")); });
    expect(screen.getByRole("region", { name: "Choose your navigation" })).toBeTruthy();
  });
  it("unrelated personalization does not silently accept the default navigation", () => {
    render(<Harness />);
    act(() => saveAppearance({ ...DEFAULT_APPEARANCE, accent: "rose" }));
    expect(screen.getByRole("region", { name: "Choose your navigation" })).toBeTruthy();
    expect(loadAppearance().navLayoutChosen).toBe(false);
  });
});
