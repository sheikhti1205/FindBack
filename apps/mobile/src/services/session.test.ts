import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginAccountSwitch,
  clearAllAuth,
  getPendingEmail,
  getToken,
  notifySignedOut,
  onSignedOut,
  setPendingEmail,
  setToken,
} from "./session";

beforeEach(() => {
  clearAllAuth();
  vi.clearAllMocks();
});

/**
 * W5-IDENTITY: A -> sign out -> B without a process restart must not leak
 * A's session slice into B's calls. beginAccountSwitch covers the
 * session-owned state (token cache + pending email + signed-out fan-out);
 * auth.tsx owns the wider wipe (user-scoped local state, realtime, push) on
 * the same paths.
 */
describe("beginAccountSwitch", () => {
  it("clears the token cache and pending email", () => {
    setToken("token-for-A");
    setPendingEmail("a@example.com");

    beginAccountSwitch();

    expect(getToken()).toBeNull();
    expect(getPendingEmail()).toBeNull();
  });

  it("notifies signed-out handlers so providers drop A-owned state", () => {
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = onSignedOut(first);
    onSignedOut(second);

    beginAccountSwitch();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    releaseFirst();
    notifySignedOut();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("leaves no residue for the next account: B starts clean", () => {
    setToken("token-for-A");
    setPendingEmail("a@example.com");
    beginAccountSwitch();

    // B signs in on the same process: only B's values are visible.
    setToken("token-for-B");

    expect(getToken()).toBe("token-for-B");
    expect(getPendingEmail()).toBeNull();
  });

  it("is idempotent: repeating the switch without a session is a no-op", () => {
    const handler = vi.fn();
    onSignedOut(handler);

    beginAccountSwitch();
    beginAccountSwitch();

    expect(getToken()).toBeNull();
    expect(getPendingEmail()).toBeNull();
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
