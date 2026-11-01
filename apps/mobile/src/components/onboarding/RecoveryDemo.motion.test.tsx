// @vitest-environment jsdom
import type { HTMLAttributes } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoveryDemo } from "./RecoveryDemo";

type MotionInput = { initial?: unknown; animate?: Record<string, unknown>; transition?: { duration?: number; delay?: number; repeat?: number } };
const state = vi.hoisted(() => ({ reduced: false, frames: [] as MotionInput[] }));
vi.mock("../uiMotion", () => ({ useShouldReduceMotion: () => state.reduced }));
vi.mock("framer-motion", () => ({ motion: { div: ({ initial, animate, transition, ...rest }: HTMLAttributes<HTMLDivElement> & MotionInput) => {
  state.frames.push({ initial, animate, transition }); return <div {...rest} />;
} } }));
afterEach(() => { cleanup(); state.reduced = false; state.frames = []; });
describe("demonstration animation contract (actual Motion browser proof is separate)", () => {
  it("all autoplay finishes within five seconds and never repeats", () => {
    render(<RecoveryDemo />);
    expect(state.frames).toHaveLength(5);
    for (const frame of state.frames) {
      expect((frame.transition?.duration ?? 0) + (frame.transition?.delay ?? 0)).toBeLessThan(5);
      expect(frame.transition?.repeat ?? 0).toBe(0);
    }
    expect(state.frames[0]?.animate?.x).toEqual([-22, -22, 0, 0]);
    expect(state.frames[1]?.animate?.x).toEqual([22, 22, 0, 0]);
  });
  it("switching to reduced motion mid-story immediately resolves all travel and delayed reveals", () => {
    const ui = render(<RecoveryDemo />); state.frames = []; state.reduced = true;
    ui.rerender(<RecoveryDemo />);
    for (const frame of state.frames) {
      expect(frame.transition?.duration).toBe(0);
      expect(frame.transition?.delay ?? 0).toBe(0);
      expect(frame.animate?.opacity).toBe(1);
      expect(Array.isArray(frame.animate?.x)).toBe(false);
    }
  });
});
