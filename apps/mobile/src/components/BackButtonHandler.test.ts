// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(), exitApp: vi.fn() } }));

import { resolveBackAction } from "./BackButtonHandler";
import {
  consumeHistorySuppression,
  requestHistorySuppression,
  resetHistorySuppression,
} from "./backNavigation";

const base = { canGoBack: false, pathname: "/", armed: false, suppressHistory: false };

describe("resolveBackAction", () => {
  it("walks history when there is a previous screen", () => {
    expect(resolveBackAction({ ...base, canGoBack: true, pathname: "/posts/9" })).toEqual({
      type: "back",
    });
    expect(resolveBackAction({ ...base, canGoBack: true })).toEqual({ type: "back" });
  });

  it("falls back to Home when history is exhausted on a non-home screen", () => {
    expect(resolveBackAction({ ...base, pathname: "/offline-ai" })).toEqual({ type: "home" });
    expect(resolveBackAction({ ...base, pathname: "/help" })).toEqual({ type: "home" });
  });

  it("arms exit on the first back press at Home", () => {
    expect(resolveBackAction(base)).toEqual({ type: "arm" });
  });

  it("exits on the second back press at Home", () => {
    expect(resolveBackAction({ ...base, armed: true })).toEqual({ type: "exit" });
  });

  it("ignores history when the user re-tapped Home", () => {
    expect(
      resolveBackAction({ ...base, canGoBack: true, suppressHistory: true }),
    ).toEqual({ type: "arm" });
    expect(
      resolveBackAction({ ...base, canGoBack: true, suppressHistory: true, armed: true }),
    ).toEqual({ type: "exit" });
  });
});

describe("history suppression store", () => {
  beforeEach(resetHistorySuppression);

  it("only applies to the path it was requested on", () => {
    requestHistorySuppression("/");
    expect(consumeHistorySuppression("/profile")).toBe(false);
    // Consuming a non-matching path still clears it.
    expect(consumeHistorySuppression("/")).toBe(false);
  });

  it("is consumed once", () => {
    requestHistorySuppression("/");
    expect(consumeHistorySuppression("/")).toBe(true);
    expect(consumeHistorySuppression("/")).toBe(false);
  });
});
