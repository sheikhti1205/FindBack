// @vitest-environment jsdom
/**
 * The one share control: the system share sheet and the copy action.
 *
 * The contract is honesty: an outcome is announced as it happened, a
 * platform without a clipboard gets a selectable link instead of a fake
 * "copied", and an impossible share is reported rather than swallowed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetNativeShare, __setNativeShare } from "../utils/shareReport";
import { ReportShareButton } from "./ReportShareButton";

const origin = "https://findbackapp.social";
const id = "5b6f7c8d-1234-4abc-8def-123456789012";
const url = `${origin}/r/${id}`;

function stubNavigator({ share, writeText }: { share?: unknown; writeText?: unknown } = {}) {
  vi.stubGlobal("navigator", {
    share,
    clipboard: writeText === undefined ? undefined : { writeText },
  });
}

/** The messages the control announces to the reader. */
function listenForAnnouncements(): { heard: string[]; stop: () => void } {
  const heard: string[] = [];
  const handler = (event: Event) => {
    heard.push((event as CustomEvent<string>).detail ?? "");
  };
  window.addEventListener("findback:announce", handler);
  return { heard, stop: () => window.removeEventListener("findback:announce", handler) };
}

beforeEach(() => {
  vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", origin);
});

afterEach(() => {
  cleanup();
  __resetNativeShare();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ReportShareButton", () => {
  function choose(name: string) {
    fireEvent.click(screen.getByRole("button", { name: "Share report" }));
    fireEvent.click(screen.getByRole("menuitem", { name }));
  }

  it("occupies one share slot and exposes both explicit actions in a nonmodal menu", () => {
    render(<ReportShareButton postId={id} title="Lost keys" />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    const trigger = screen.getByRole("button", { name: "Share report" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Share report" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy link" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("supports keyboard navigation, Escape focus return and non-trapping Tab", () => {
    render(<ReportShareButton postId={id} title="Lost keys" />);
    const trigger = screen.getByRole("button", { name: "Share report" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const share = screen.getByRole("menuitem", { name: "Share report" });
    const copy = screen.getByRole("menuitem", { name: "Copy link" });
    expect(document.activeElement).toBe(share);
    fireEvent.keyDown(share, { key: "ArrowDown" });
    expect(document.activeElement).toBe(copy);
    fireEvent.keyDown(copy, { key: "Home" });
    expect(document.activeElement).toBe(share);
    fireEvent.keyDown(share, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Copy link" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("dismisses the native sheet honestly and does not copy", async () => {
    __setNativeShare(vi.fn().mockResolvedValue("dismissed"));
    const writeText = vi.fn();
    stubNavigator({ writeText });
    const { heard, stop } = listenForAnnouncements();
    try {
      render(<ReportShareButton postId={id} title="Lost keys" />);
      choose("Share report");
      await waitFor(() => expect(heard).toContain("Share dismissed."));
      expect(writeText).not.toHaveBeenCalled();
    } finally { stop(); }
  });
  it("copies the public report link and announces the copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ writeText });
    const { heard, stop } = listenForAnnouncements();
    try {
      render(<ReportShareButton postId={id} title="Lost keys" />);

      choose("Copy link");

      await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
      await waitFor(() => expect(heard).toContain("Link copied."));
      // A copy that happened must not leave the manual field on screen.
      expect(screen.queryByLabelText("Report link")).toBeNull();
    } finally {
      stop();
    }
  });

  it("offers the link in a selectable field when the platform has no clipboard", async () => {
    stubNavigator();
    const { heard, stop } = listenForAnnouncements();
    try {
      render(<ReportShareButton postId={id} title="Lost keys" />);

      choose("Copy link");

      const field = (await screen.findByLabelText("Report link")) as HTMLInputElement;
      expect(field.value).toBe(url);
      expect(field.readOnly).toBe(true);
      // It must never claim a copy that did not happen.
      await waitFor(() => expect(heard.join(" ")).toMatch(/isn't available/i));
      expect(heard).not.toContain("Link copied.");
    } finally {
      stop();
    }
  });

  it("shares through the system sheet and announces the outcome", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ share });
    const { heard, stop } = listenForAnnouncements();
    try {
      render(<ReportShareButton postId={id} title="Lost keys" />);

      choose("Share report");

      await waitFor(() => expect(share).toHaveBeenCalledWith({ title: "Lost keys", url }));
      await waitFor(() => expect(heard).toContain("Link shared."));
    } finally {
      stop();
    }
  });

  it("opens the native system sheet on a device", async () => {
    const native = vi.fn().mockResolvedValue("shared");
    __setNativeShare(native);
    stubNavigator();
    const { heard, stop } = listenForAnnouncements();
    try {
      render(<ReportShareButton postId={id} title="Lost keys" />);

      choose("Share report");

      await waitFor(() => expect(native).toHaveBeenCalledWith({ title: "Lost keys", url }));
      await waitFor(() => expect(heard).toContain("Link shared."));
    } finally {
      stop();
    }
  });

  it("reports an impossible share instead of pretending it worked", async () => {
    stubNavigator();
    const { heard, stop } = listenForAnnouncements();
    try {
      render(<ReportShareButton postId={id} title="Lost keys" />);

      choose("Share report");

      await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
      expect(screen.getByRole("alert").textContent).toMatch(/couldn't share/i);
      await waitFor(() => expect(heard.join(" ")).toMatch(/couldn't share/i));
    } finally {
      stop();
    }
  });
});

describe("ReportShareButton lifetime", () => {
  const first = "aaaaaaaa-1111-4111-8111-111111111111";
  const second = "bbbbbbbb-2222-4222-8222-222222222222";

  function chooseShare(name: string) {
    fireEvent.click(screen.getByRole("button", { name: "Share report" }));
    fireEvent.click(screen.getByRole("menuitem", { name }));
  }

  function deferred() {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  it("never shows the previous report's manual link after a pending copy crosses identity replacement", async () => {
    const pending = deferred();
    stubNavigator({ writeText: () => pending.promise });
    const { heard, stop } = listenForAnnouncements();
    try {
      const view = render(<ReportShareButton postId={first} title="A" />);
      chooseShare("Copy link");
      view.rerender(<ReportShareButton postId={second} title="B" />);
      await act(async () => pending.reject(new Error("clipboard refused")));
      expect(screen.queryByLabelText("Report link")).toBeNull();
      expect(heard).toEqual([]);
    } finally { stop(); }
  });

  it("never announces a share that completes after its report control unmounted", async () => {
    const pending = deferred();
    stubNavigator({ share: () => pending.promise });
    const { heard, stop } = listenForAnnouncements();
    try {
      const view = render(<ReportShareButton postId={first} title="A" />);
      chooseShare("Share report");
      view.unmount();
      await act(async () => pending.resolve());
      expect(heard).toEqual([]);
    } finally { stop(); }
  });

  it("never announces a share that completes after the report identity changed", async () => {
    const pending = deferred();
    stubNavigator({ share: () => pending.promise });
    const { heard, stop } = listenForAnnouncements();
    try {
      const view = render(<ReportShareButton postId={first} title="A" />);
      chooseShare("Share report");
      view.rerender(<ReportShareButton postId={second} title="B" />);
      await act(async () => pending.resolve());
      expect(heard).toEqual([]);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally { stop(); }
  });

  it("never reopens a menu or announces a failure that lands after unmount", async () => {
    stubNavigator();
    const { heard, stop } = listenForAnnouncements();
    try {
      const view = render(<ReportShareButton postId={first} title="A" />);
      chooseShare("Share report");
      view.unmount();
      await act(async () => {});
      expect(heard).toEqual([]);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally { stop(); }
  });

  it("drops the previous report's error when the control now shows another report", async () => {
    stubNavigator();
    const view = render(<ReportShareButton postId={first} title="A" />);
    chooseShare("Share report");
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    view.rerender(<ReportShareButton postId={second} title="B" />);
    fireEvent.click(screen.getByRole("button", { name: "Share report" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Share report" })).toBeTruthy();
  });
});
