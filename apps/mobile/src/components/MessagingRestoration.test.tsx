// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessagingRestoration } from "./MessagingRestoration";
import { consumeBackIntercept, resetBackInterceptors } from "./backNavigation";
const state = vi.hoisted(() => ({ threadSync: null as unknown, restoration: null as unknown }));
vi.mock("../services/messaging/useMessaging", () => ({ useMessaging: () => state }));
afterEach(() => { cleanup(); resetBackInterceptors(); state.threadSync = null; state.restoration = null; });

it.each(["backup", "history"])("isolates and blurs the whole screen during %s restore, releasing on failure or completion", async source => {
  const root = render(<><button>Other screen action</button><MessagingRestoration /></>);
  const trigger = screen.getByRole("button"); trigger.focus();
  state.restoration = { source, missing: 11 }; root.rerender(<><button>Other screen action</button><MessagingRestoration /></>);
  const dialog = screen.getByRole("dialog", { name: "Restoring messages" });
  expect(root.container.hasAttribute("inert")).toBe(true);
  expect(screen.getByTestId("bottom-sheet-backdrop").className).toContain("backdrop-blur");
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(consumeBackIntercept()).toBe(true);
  expect(screen.getByRole("dialog")).toBeTruthy();
  state.restoration = null;
  await act(async () => root.rerender(<><button>Other screen action</button><MessagingRestoration /></>));
  expect(screen.queryByRole("dialog")).toBeNull(); expect(root.container.hasAttribute("inert")).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

it("does not interrupt a routine ten-message update", () => {
  state.threadSync = { mode: "soft", missing: 10 };
  render(<MessagingRestoration />); expect(screen.queryByRole("dialog")).toBeNull();
});
