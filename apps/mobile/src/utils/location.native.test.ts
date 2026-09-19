// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const appLauncher = vi.hoisted(() => ({ openUrl: vi.fn() }));
const shortLinkResolver = vi.hoisted(() => ({ resolve: vi.fn() }));
const platform = vi.hoisted(() => ({ native: true }));
const registerPluginMock = vi.hoisted(() => vi.fn());

vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: {
      isNativePlatform: () => platform.native,
      getPlatform: () => (platform.native ? "android" : "web"),
    },
    registerPlugin: registerPluginMock,
  };
});
vi.mock("@capacitor/app-launcher", () => ({ AppLauncher: appLauncher }));

// Set up the mock to return the shortLinkResolver when called with "ShortLinkResolver"
registerPluginMock.mockImplementation((name: string) => {
  if (name === "ShortLinkResolver") return shortLinkResolver;
  return {};
});

import { openInMaps, openInMapsNative } from "./location";

describe("openInMaps native handoff", () => {
  beforeEach(() => {
    appLauncher.openUrl.mockReset();
    shortLinkResolver.resolve.mockReset();
    platform.native = true;
  });

  it("opens the universal Maps URL through AppLauncher on Android", async () => {
    appLauncher.openUrl.mockResolvedValue({ completed: true });
    await openInMapsNative(23.8, 90.4, "");
    expect(appLauncher.openUrl).toHaveBeenCalledWith({
      url: "https://www.google.com/maps/search/?api=1&query=23.8,90.4",
    });
  });

  it("falls back to a web window when the plugin rejects", async () => {
    appLauncher.openUrl.mockRejectedValue(new Error("no activity"));
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await openInMapsNative(null, null, "Chittagong");
    expect(open).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("fires the handoff through the void wrapper", async () => {
    appLauncher.openUrl.mockResolvedValue({ completed: true });
    openInMaps(23.8, 90.4, "");
    await vi.waitFor(() => expect(appLauncher.openUrl).toHaveBeenCalled());
  });
});