// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const browser = vi.hoisted(() => ({ open: vi.fn() }));
const platform = vi.hoisted(() => ({ native: true }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => (platform.native ? "android" : "web"),
  },
}));
vi.mock("@capacitor/browser", () => ({ Browser: browser }));

import { openInMaps, openInMapsNative } from "./location";

describe("openInMaps native handoff", () => {
  it("opens the universal Maps URL through the Browser plugin on Android", async () => {
    browser.open.mockReset().mockResolvedValue(undefined);
    await openInMapsNative(23.8, 90.4, "");
    expect(browser.open).toHaveBeenCalledWith({
      url: "https://www.google.com/maps/search/?api=1&query=23.8,90.4",
    });
  });

  it("falls back to a web window when the plugin rejects", async () => {
    browser.open.mockReset().mockRejectedValue(new Error("no activity"));
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await openInMapsNative(null, null, "Chittagong");
    expect(open).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("fires the handoff through the void wrapper", async () => {
    browser.open.mockReset().mockResolvedValue(undefined);
    openInMaps(23.8, 90.4, "");
    await vi.waitFor(() => expect(browser.open).toHaveBeenCalled());
  });
});
