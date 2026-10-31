// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaViewer, type MediaViewerItem } from "./MediaViewer";
import { consumeBackIntercept } from "./backNavigation";

const items: MediaViewerItem[] = [
  { id: "a", src: "https://example.test/front.jpg", alt: "Blue wallet front", width: 1600, height: 1200 },
  { id: "b", src: "https://example.test/back.jpg", alt: "Blue wallet back", width: 1200, height: 1600 },
];

function Gallery({ initial = 0 }: { initial?: number }) {
  const [index, setIndex] = useState<number | null>(null);
  return <><button onClick={() => setIndex(initial)}>Inspect wallet</button>
    <MediaViewer items={items} index={index} onIndexChange={setIndex} onClose={() => setIndex(null)} /></>;
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1024, bottom: 768, width: 1024, height: 768, toJSON: () => ({}) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("MediaViewer boundary", () => {
  it("does not create an overlay or fetch photos while closed or empty", () => {
    const { rerender } = render(<MediaViewer items={items} index={null} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    rerender(<MediaViewer items={[]} index={0} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens at the selected image and prevents wrap at both boundaries", async () => {
    render(<Gallery initial={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect wallet" }));
    await screen.findByRole("dialog", { name: "Photo viewer" });
    expect(screen.getByText("Photo 2 of 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next photo" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Previous photo" }));
    await waitFor(() => expect(screen.getByText("Photo 1 of 2")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Previous photo" })).toHaveProperty("disabled", true);
    expect(within(screen.getByRole("group", { name: "1 of 2" })).getByRole("img", { name: "Blue wallet front" }).getAttribute("src")).toContain("front.jpg");
  });

  it("closes with Escape and restores the launcher, including the native Back bridge", async () => {
    render(<Gallery />);
    const trigger = screen.getByRole("button", { name: "Inspect wallet" });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger); await screen.findByRole("dialog");
    await act(async () => { expect(consumeBackIntercept()).toBe(true); });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows only a generic error and retries the existing source without exposing URLs", async () => {
    render(<Gallery />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect wallet" }));
    const group = await screen.findByRole("group", { name: "1 of 2" });
    const photo = within(group).getByRole("img", { name: "Blue wallet front" });
    fireEvent.error(photo);
    expect(screen.getByText("Photo unavailable")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).not.toContain("example.test");
    fireEvent.click(screen.getByRole("button", { name: "Retry photo" }));
    const retry = within(group).getByRole("img", { name: "Blue wallet front" });
    expect(retry).not.toBe(photo);
    expect(retry.getAttribute("src")).toBe("https://example.test/front.jpg");
  });

  it("reopening restores phone chrome instead of retaining the last hidden state", async () => {
    render(<Gallery />);
    const trigger = screen.getByRole("button", { name: "Inspect wallet" });
    fireEvent.click(trigger);
    const group = await screen.findByRole("group", { name: "1 of 2" });
    fireEvent.click(within(group).getByRole("img", { name: "Blue wallet front" }));
    expect(screen.getByRole("dialog").className).toContain("fb-viewer-chrome-hidden");
    act(() => { consumeBackIntercept(); });
    fireEvent.click(trigger);
    expect((await screen.findByRole("dialog")).className).not.toContain("fb-viewer-chrome-hidden");
  });

  it("keeps failed filmstrip thumbnails noninteractive inside their navigation button", async () => {
    render(<Gallery />);
    fireEvent.click(screen.getByRole("button", { name: "Inspect wallet" }));
    const thumbnails = await screen.findByRole("navigation", { name: "Thumbnails" });
    fireEvent.error(thumbnails.querySelector("img")!);
    expect(within(thumbnails).queryByText("Photo unavailable")).toBeNull();
    expect(thumbnails.querySelector("button button")).toBeNull();
    expect(within(thumbnails).getByRole("button", { name: "1 of 2" })).toBeTruthy();
  });
});
