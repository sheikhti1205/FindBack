// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";
vi.mock("@capacitor/share", () => ({ Share: { share: vi.fn() } }));
import {
  __resetNativeShare,
  __setNativeShare,
  copyReportLink,
  shareReport,
} from "./shareReport";

const origin = "https://findbackapp.social";
const id = "5b6f7c8d-1234-4abc-8def-123456789012";
const url = `${origin}/r/${id}`;

function stubNavigator({ share, writeText }: { share?: unknown; writeText?: unknown } = {}) {
  vi.stubGlobal("navigator", {
    share,
    clipboard: writeText === undefined ? undefined : { writeText },
  });
}

beforeEach(() => {
  vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", origin);
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetNativeShare();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("shareReport", () => {
  it("shares the canonical public report URL through the system sheet", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ share });

    await expect(shareReport(id, "Lost keys")).resolves.toBe("Link shared.");

    expect(share).toHaveBeenCalledWith({ title: "Lost keys", url });
  });

  it("treats a user-dismissed sheet as a cancellation, not a failure", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({
      share: vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError")),
      writeText,
    });

    await expect(shareReport(id, "Lost keys")).resolves.toBe("Share dismissed.");

    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to the clipboard when sharing fails for any other reason", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({
      share: vi.fn().mockRejectedValue(new Error("share sheet unavailable")),
      writeText,
    });

    await expect(shareReport(id, "Lost keys")).resolves.toBe("Link copied to clipboard.");

    expect(writeText).toHaveBeenCalledWith(url);
  });

  it("copies to the clipboard when the platform has no share sheet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ writeText });

    await expect(shareReport(id, "Lost keys")).resolves.toBe("Link copied to clipboard.");

    expect(writeText).toHaveBeenCalledWith(url);
  });

  it("throws rather than silently dropping the link when neither path exists", async () => {
    stubNavigator();

    await expect(shareReport(id, "Lost keys")).rejects.toThrow(/not supported/i);
  });

  it("propagates a missing share origin instead of sharing a local URL", async () => {
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", "");
    stubNavigator({ share: vi.fn() });

    await expect(shareReport(id, "Lost keys")).rejects.toThrow(/share origin/i);
  });
});

describe("shareReport on a device (native system sheet)", () => {
  it("calls the installed plugin API on a native platform without navigator.share", async () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    vi.mocked(Share.share).mockResolvedValue({ activityType: "test-target" });
    stubNavigator();
    await expect(shareReport(id, "Lost keys")).resolves.toBe("Link shared.");
    expect(Share.share).toHaveBeenCalledWith({ title: "Lost keys", url });
  });

  it("recognizes the installed Android plugin's cancellation error without copying", async () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    vi.mocked(Share.share).mockRejectedValue(new Error("Share canceled"));
    const writeText = vi.fn();
    stubNavigator({ writeText });
    await expect(shareReport(id, "Lost keys")).resolves.toBe("Share dismissed.");
    expect(writeText).not.toHaveBeenCalled();
  });
  it("opens the native sheet with the canonical link and reports the share", async () => {
    const native = vi.fn().mockResolvedValue("shared");
    __setNativeShare(native);
    stubNavigator();

    await expect(shareReport(id, "Lost keys")).resolves.toBe("Link shared.");

    expect(native).toHaveBeenCalledWith({ title: "Lost keys", url });
  });

  it("reports a dismissed native sheet as a cancellation and copies nothing", async () => {
    const native = vi.fn().mockResolvedValue("dismissed");
    __setNativeShare(native);
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ writeText });

    await expect(shareReport(id, "Lost keys")).resolves.toBe("Share dismissed.");

    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to the clipboard when the native sheet fails", async () => {
    const native = vi.fn().mockResolvedValue("failed");
    __setNativeShare(native);
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ writeText });

    await expect(shareReport(id, "Lost keys")).resolves.toBe("Link copied to clipboard.");

    expect(writeText).toHaveBeenCalledWith(url);
  });

  it("reports honestly when the native sheet failed and no clipboard exists", async () => {
    __setNativeShare(vi.fn().mockResolvedValue("failed"));
    stubNavigator();

    await expect(shareReport(id, "Lost keys")).rejects.toThrow(/not supported/i);
  });
});

describe("copyReportLink", () => {
  it("copies the same public link the share sends", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ writeText });

    await expect(copyReportLink(id)).resolves.toEqual({ status: "copied" });

    expect(writeText).toHaveBeenCalledWith(url);
  });

  it("reports a manual copy when the platform exposes no clipboard", async () => {
    stubNavigator();

    await expect(copyReportLink(id)).resolves.toEqual({ status: "manual", url });
  });

  it("reports a manual copy when the clipboard refuses the write", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("not allowed"));
    stubNavigator({ writeText });

    await expect(copyReportLink(id)).resolves.toEqual({ status: "manual", url });
  });

  it("propagates a missing share origin instead of copying a local URL", async () => {
    vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", "");
    stubNavigator({ writeText: vi.fn() });

    await expect(copyReportLink(id)).rejects.toThrow(/share origin/i);
  });
});
