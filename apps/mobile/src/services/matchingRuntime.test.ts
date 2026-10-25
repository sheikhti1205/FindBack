// @vitest-environment jsdom
import { expect, it } from "vitest";
import { applyMatchesEngineToRuntime } from "./possibleMatches";
import { getApplicationAi } from "./ai/applicationAi";

it("applies the retained matching preference without importing a retired settings screen", () => {
  const service = getApplicationAi();
  expect(applyMatchesEngineToRuntime("use")).toBe(true);
  expect(service.matchingBackend).toBe("use");
  // No Android/verified install in this host: refuse rather than claim Needle.
  expect(applyMatchesEngineToRuntime("needle")).toBe(false);
  expect(service.matchingBackend).toBe("use");
  expect(applyMatchesEngineToRuntime("use")).toBe(true);
});
