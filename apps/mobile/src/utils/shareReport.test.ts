// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareReport } from "./shareReport";

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
