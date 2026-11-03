import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ platform: "android", getColors: vi.fn(), addListener: vi.fn(), remove: vi.fn(), register: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => bridge.platform, isNativePlatform: () => bridge.platform === "android" },
  registerPlugin: (name: string) => { bridge.register(name); return bridge; },
}));
const good = {
  supported: true,
  light: { primary: "#006a6a", onPrimary: "#ffffff", primaryContainer: "#ddf2f1", onPrimaryContainer: "#003838", link: "#003838" },
  dark: { primary: "#7bd8d8", onPrimary: "#003838", primaryContainer: "#153c3c", onPrimaryContainer: "#7bd8d8", link: "#7bd8d8" },
};
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); bridge.platform = "android";
  bridge.getColors.mockResolvedValue(good);
  bridge.addListener.mockResolvedValue({ remove: bridge.remove });
});
afterEach(() => vi.useRealTimers());
describe("bounded read-only native System colors owner", () => {
  it("never registers Android wallpaper capabilities on web", async () => {
    bridge.platform = "web";
    const m = await import("./systemColors");
    expect(await m.refreshSystemColors()).toEqual({ supported: false, palette: null });
    expect(bridge.register).not.toHaveBeenCalled();
  });
  it("accepts safe native principal roles without altering their values", async () => {
    const m = await import("./systemColors");
    expect(await m.refreshSystemColors()).toEqual({ supported: true, palette: { light: good.light, dark: good.dark } });
    expect(bridge.register).toHaveBeenCalledWith("FindbackSystemColors");
  });
  it("old Android and rejected native reads yield no fabricated palette", async () => {
    const m = await import("./systemColors");
    bridge.getColors.mockResolvedValueOnce({ supported: false });
    expect((await m.refreshSystemColors()).palette).toBeNull();
    bridge.getColors.mockRejectedValueOnce(new Error("unavailable"));
    expect(await m.refreshSystemColors()).toEqual({ supported: false, palette: null });
  });
  it("replaces only unsafe role groups with Blue, not an arbitrary last preset", async () => {
    const m = await import("./systemColors");
    const payload = structuredClone(good); payload.light.primary = "#eeeeee"; payload.light.link = "red; --fb-error: green";
    bridge.getColors.mockResolvedValue(payload);
    const result = await m.refreshSystemColors();
    expect(result.palette?.light).toEqual({ ...good.light, primary: "#3568d4", onPrimary: "#ffffff", link: "#082b60" });
    expect(result.palette?.dark).toEqual(good.dark);
  });
  it("a low-contrast container replaces the pair rather than mixing incompatible inks", async () => {
    const m = await import("./systemColors");
    const payload = structuredClone(good); payload.dark.primaryContainer = "#7bd8d8";
    bridge.getColors.mockResolvedValue(payload);
    const result = await m.refreshSystemColors();
    expect(result.palette?.dark).toMatchObject({ primary: good.dark.primary, primaryContainer: "#1c355c", onPrimaryContainer: "#adc7ff" });
  });
  it("ignores earlier replies when a newer palette has already settled", async () => {
    const m = await import("./systemColors");
    let resolve!: (value: unknown) => void;
    bridge.getColors.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const old = m.refreshSystemColors();
    await m.refreshSystemColors(); resolve({ supported: false }); await old;
    expect(m.getSystemColorsSnapshot().supported).toBe(true);
  });
  it("bounds a hung bridge and ignores its late settlement", async () => {
    vi.useFakeTimers();
    const m = await import("./systemColors");
    let resolve!: (value: unknown) => void;
    bridge.getColors.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const work = m.refreshSystemColors(); await vi.advanceTimersByTimeAsync(3001);
    expect(await work).toEqual({ supported: false, palette: null });
    resolve(good); await Promise.resolve();
    expect(m.getSystemColorsSnapshot().palette).toBeNull();
  });
  it("refreshes on native resume/configuration event and cleans delayed listener registration", async () => {
    const m = await import("./systemColors");
    let changed!: () => void;
    let resolve!: (handle: { remove: typeof bridge.remove }) => void;
    bridge.addListener.mockImplementation((_event: string, listener: () => void) => { changed = listener; return new Promise(r => { resolve = r; }); });
    const stop = m.startSystemColorUpdates();
    expect(bridge.getColors).toHaveBeenCalledTimes(1);
    changed(); expect(bridge.getColors).toHaveBeenCalledTimes(2);
    stop(); resolve({ remove: bridge.remove }); await Promise.resolve(); await Promise.resolve();
    expect(bridge.remove).toHaveBeenCalledTimes(1);
    changed(); expect(bridge.getColors).toHaveBeenCalledTimes(2);
  });
});
