// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { experimentalProvidersEnabled, isProviderEnabled, setExperimentalProvidersEnabled } from "./providerStatus";

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
it("default-off opt-in is per account, revocable, and never hides on-device models", () => {
  expect(isProviderEnabled("a", "openrouter")).toBe(true);
  expect(isProviderEnabled("a", "offline")).toBe(true);
  expect(isProviderEnabled("a", "anthropic")).toBe(false);
  setExperimentalProvidersEnabled("a", true);
  expect(isProviderEnabled("a", "anthropic")).toBe(true);
  expect(isProviderEnabled("b", "anthropic")).toBe(false);
  setExperimentalProvidersEnabled("a", false);
  expect(isProviderEnabled("a", "anthropic")).toBe(false);
  expect(isProviderEnabled("a", "offline")).toBe(true);
});
it("corrupt or unavailable opt-in storage fails closed", () => {
  localStorage.setItem("findback.ai.experimentalProviders.v1.a", '"true"');
  expect(experimentalProvidersEnabled("a")).toBe(false);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(() => setExperimentalProvidersEnabled("a", true)).not.toThrow();
  expect(isProviderEnabled("a", "groq")).toBe(false);
});
