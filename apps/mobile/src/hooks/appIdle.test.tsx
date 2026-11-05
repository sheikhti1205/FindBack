// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { isGenuinelyIdle, useAppIdle } from "./appIdle";
import { popModalLayer, pushModalLayer, resetModalLayers } from "./modalLayers";

afterEach(() => { cleanup(); resetModalLayers(); document.body.replaceChildren(); });

describe("passive interruption gate", () => {
  it.each(["/auth", "/report", "/posts/id/edit", "/chats/id", "/help", "/settings/updates", "/settings/account", "/settings/media", "/unknown"])("does not interrupt protected work at %s", path => {
    expect(isGenuinelyIdle(path)).toBe(false);
  });
  it.each(["/", "/my", "/notifications", "/settings", "/settings/about"])("allows an otherwise idle passive destination %s", path => {
    expect(isGenuinelyIdle(path)).toBe(true);
  });
  it("reacts to focus and modal ownership without polling", () => {
    const { result } = renderHook(() => useAppIdle("/"));
    expect(result.current).toBe(true);
    const editor = document.createElement("textarea"); document.body.append(editor);
    act(() => editor.focus()); expect(result.current).toBe(false);
    act(() => editor.blur()); expect(result.current).toBe(true);
    act(() => pushModalLayer("synthetic")); expect(result.current).toBe(false);
    act(() => popModalLayer("synthetic")); expect(result.current).toBe(true);
  });
});
