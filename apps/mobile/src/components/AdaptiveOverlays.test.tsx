// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActionMenu } from "./ActionMenu";
import { AdaptiveTaskSurface, ConfirmDialog } from "./AdaptiveTaskSurface";
import { BottomSheet } from "./BottomSheet";
import { consumeBackIntercept, resetBackInterceptors } from "./backNavigation";
import { resetModalLayers } from "../hooks/modalLayers";

afterEach(() => { cleanup(); resetBackInterceptors(); resetModalLayers(); });

it("bounds a task to the visual viewport when the IME overlays the layout viewport", () => {
  const previous = window.visualViewport;
  const viewport = new EventTarget();
  Object.defineProperties(viewport, { height: { configurable: true, value: window.innerHeight }, offsetTop: { value: 0 } });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  try {
    render(<AdaptiveTaskSurface open onClose={() => {}} title="Edit report"><input aria-label="Report title" /></AdaptiveTaskSurface>);
    Object.defineProperty(viewport, "height", { value: 400 });
    act(() => viewport.dispatchEvent(new Event("resize")));
    expect((document.querySelector(".fb-modal-backdrop") as HTMLElement).style.height).toBe("400px");
  } finally {
    cleanup();
    Object.defineProperty(window, "visualViewport", { configurable: true, value: previous });
  }
});

it("opens an anchored menu, navigates enabled actions and returns focus on Escape", async () => {
  render(<ActionMenu label="Report actions" items={[
    { id: "save", label: "Save", onAction: vi.fn() },
    { id: "locked", label: "Unavailable", disabled: true, onAction: vi.fn() },
    { id: "delete", label: "Delete", destructive: true, onAction: vi.fn() },
  ]} />);
  const trigger = screen.getByRole("button", { name: "Report actions" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const menu = await screen.findByRole("menu", { name: "Report actions" });
  const save = within(menu).getByRole("menuitem", { name: "Save" });
  await waitFor(() => expect(document.activeElement).toBe(save));
  fireEvent.keyDown(save, { key: "ArrowDown" });
  await waitFor(() => expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Delete" })));
  expect(within(menu).getByRole("separator")).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("opens one submenu by tap without hover; Back closes that panel before the root", async () => {
  const copy = vi.fn();
  render(<ActionMenu label="Actions" items={[
    { id: "share", label: "Share", items: [{ id: "copy", label: "Copy link", onAction: copy }] },
  ]} />);
  fireEvent.click(screen.getByRole("button", { name: "Actions" }));
  const menu = await screen.findByRole("menu", { name: "Actions" });
  await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  const share = screen.getByRole("menuitem", { name: "Share" });
  act(() => share.focus());
  fireEvent.click(share);
  const copyAction = await screen.findByRole("menuitem", { name: "Copy link" });
  const submenu = screen.getByRole("menu", { name: "Share" });
  await waitFor(() => expect(submenu.contains(document.activeElement)).toBe(true));
  act(() => copyAction.focus());
  act(() => { expect(consumeBackIntercept()).toBe(true); });
  await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Copy link" })).toBeNull());
  expect(screen.getByRole("menuitem", { name: "Share" })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(share));
  fireEvent.click(screen.getByRole("menuitem", { name: "Share" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

it("confirmation starts on Cancel, retains caller-owned failures and refuses dismissal while busy", async () => {
  const confirm = vi.fn();
  function Example() {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    return <>
      <button onClick={() => setOpen(true)}>Remove</button>
      <ConfirmDialog open={open} onClose={() => setOpen(false)} title="Remove files?"
        description="You can download them again." confirmLabel="Remove files" busy={busy}
        onConfirm={() => { confirm(); setBusy(true); }} />
    </>;
  }
  render(<Example />);
  const launcher = screen.getByRole("button", { name: "Remove" });
  launcher.focus(); fireEvent.click(launcher);
  const dialog = await screen.findByRole("alertdialog", { name: "Remove files?" });
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove files" }));
  fireEvent.keyDown(dialog, { key: "Escape" });
  act(() => { expect(consumeBackIntercept()).toBe(true); });
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(within(dialog).getByRole("button", { name: "Remove files" }).hasAttribute("disabled")).toBe(true);
});

it("only the upper layer closes over a legacy task sheet and focus returns to its launcher", async () => {
  function Example() {
    const [sheet, setSheet] = useState(true);
    const [task, setTask] = useState(false);
    return <BottomSheet open={sheet} onClose={() => setSheet(false)} title="Parent task">
      <button onClick={() => setTask(true)}>Open filters</button>
      <AdaptiveTaskSurface open={task} onClose={() => setTask(false)} title="Filters">
        <input aria-label="Filter text" />
      </AdaptiveTaskSurface>
    </BottomSheet>;
  }
  render(<Example />);
  const launcher = screen.getByRole("button", { name: "Open filters" });
  launcher.focus(); fireEvent.click(launcher);
  const dialog = await screen.findByRole("dialog", { name: "Filters" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull());
  expect(screen.getByRole("dialog", { name: "Parent task" })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(launcher));
});
