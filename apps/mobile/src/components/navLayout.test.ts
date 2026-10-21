// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE } from "../appearance";
import { COMPACT_MAX_PX } from "./responsive";
import { resolveNavLayout, useNavLayout } from "./navLayout";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function storeNavLayout(navLayout: "bottom" | "rail") {
  localStorage.setItem(
    APPEARANCE_STORAGE_KEY,
    JSON.stringify({ ...DEFAULT_APPEARANCE, navLayout }),
  );
}

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

describe("resolveNavLayout", () => {
  it("keeps the bottom bar on narrow viewports even when a rail is stored", () => {
    expect(resolveNavLayout("rail", false)).toBe("bottom");
    expect(resolveNavLayout("bottom", false)).toBe("bottom");
  });

  it("honours a stored rail once the viewport is wide", () => {
    expect(resolveNavLayout("rail", true)).toBe("rail");
  });

  it("honours a stored bottom bar on wide viewports", () => {
    expect(resolveNavLayout("bottom", true)).toBe("bottom");
  });
});

describe("useNavLayout", () => {
  it("defaults to the bottom bar", () => {
    setWidth(1024);
    const { result } = renderHook(() => useNavLayout());
    expect(result.current).toBe("bottom");
  });

  it("resolves a stored rail to the bottom bar below the breakpoint", () => {
    setWidth(COMPACT_MAX_PX - 1);
    storeNavLayout("rail");
    const { result } = renderHook(() => useNavLayout());
    expect(result.current).toBe("bottom");
  });

  it("resolves a stored rail to the rail at the breakpoint", () => {
    setWidth(COMPACT_MAX_PX);
    storeNavLayout("rail");
    const { result } = renderHook(() => useNavLayout());
    expect(result.current).toBe("rail");
  });

  it("re-resolves when the viewport crosses the breakpoint, without a reload", () => {
    setWidth(COMPACT_MAX_PX - 1);
    storeNavLayout("rail");
    const { result } = renderHook(() => useNavLayout());
    expect(result.current).toBe("bottom");
    setWidth(COMPACT_MAX_PX);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(result.current).toBe("rail");
  });
});
