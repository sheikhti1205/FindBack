import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPasswordRecovery, requestPasswordReset } from "./auth";
import { clearAllAuth, getToken, setToken } from "./session";

const { shared, isolated, create } = vi.hoisted(() => {
  const shared = { auth: { resetPasswordForEmail: vi.fn(), verifyOtp: vi.fn(), updateUser: vi.fn() } };
  const isolated = { auth: { verifyOtp: vi.fn(), getUser: vi.fn(), updateUser: vi.fn(), dispose: vi.fn() } };
  return { shared, isolated, create: vi.fn(() => isolated) };
});
vi.mock("./supabaseClient", async (original) => ({ ...await original<typeof import("./supabaseClient")>(), getSupabase: () => shared }));
vi.mock("@supabase/supabase-js", async (original) => ({ ...await original<typeof import("@supabase/supabase-js")>(), createClient: create }));

const user = { id: "recovery-account", email: "recover@example.invalid" };
beforeEach(() => {
  vi.clearAllMocks();
  clearAllAuth(); setToken("synthetic-existing-account-session");
  isolated.auth.verifyOtp.mockResolvedValue({ data: { user, session: { user, access_token: "synthetic-recovery-session" } }, error: null });
  isolated.auth.getUser.mockResolvedValue({ data: { user }, error: null });
  isolated.auth.updateUser.mockResolvedValue({ data: { user }, error: null });
  isolated.auth.dispose.mockResolvedValue(undefined);
  shared.auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
});
afterEach(() => { clearAllAuth(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("isolated recovery OTP", () => {
  it("verifies recovery and updates only that identity without replacing the current account", async () => {
    const recovery = createPasswordRecovery();
    await recovery.verify(" recover@example.invalid ", "123456");
    await recovery.updatePassword("new-password-123");
    expect(isolated.auth.verifyOtp).toHaveBeenCalledWith({ email: user.email, token: "123456", type: "recovery" });
    expect(create).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ auth: expect.objectContaining({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }) }));
    expect(isolated.auth.updateUser).toHaveBeenCalledWith({ password: "new-password-123" });
    expect(shared.auth.verifyOtp).not.toHaveBeenCalled(); expect(shared.auth.updateUser).not.toHaveBeenCalled();
    expect(getToken()).toBe("synthetic-existing-account-session");
    await recovery.dispose();
  });
  it("refuses updates before recovery verification and rejects malformed codes locally", async () => {
    const recovery = createPasswordRecovery();
    await expect(recovery.updatePassword("new-password-123")).rejects.toThrow(/code|verify|recovery/i);
    await expect(recovery.verify(user.email, "12345")).rejects.toThrow(/six|6|code/i);
    expect(isolated.auth.verifyOtp).not.toHaveBeenCalled(); expect(isolated.auth.updateUser).not.toHaveBeenCalled();
    await recovery.dispose();
  });
  it("rejects a missing session and a different recovered email", async () => {
    const recovery = createPasswordRecovery();
    isolated.auth.verifyOtp.mockResolvedValueOnce({ data: { user, session: null }, error: null });
    await expect(recovery.verify(user.email, "123456")).rejects.toThrow();
    isolated.auth.verifyOtp.mockResolvedValueOnce({ data: { user: { ...user, email: "other@example.invalid" }, session: { user: { ...user, email: "other@example.invalid" } } }, error: null });
    await expect(recovery.verify(user.email, "123456")).rejects.toThrow();
    expect(isolated.auth.updateUser).not.toHaveBeenCalled();
    await recovery.dispose();
  });
  it("checks the recovered account again before a password write", async () => {
    const recovery = createPasswordRecovery(); await recovery.verify(user.email, "123456");
    isolated.auth.getUser.mockResolvedValueOnce({ data: { user: { ...user, id: "wrong-account" } }, error: null });
    await expect(recovery.updatePassword("new-password-123")).rejects.toThrow();
    expect(isolated.auth.updateUser).not.toHaveBeenCalled(); await recovery.dispose();
  });
  it("invalidates a late verification after the recovery screen is abandoned", async () => {
    let finish!: (value: unknown) => void;
    isolated.auth.verifyOtp.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const recovery = createPasswordRecovery(); const pending = recovery.verify(user.email, "123456");
    const rejection = expect(pending).rejects.toThrow();
    await recovery.dispose(); finish({ data: { user, session: { user } }, error: null }); await rejection;
    await expect(recovery.updatePassword("new-password-123")).rejects.toThrow();
    expect(shared.auth.updateUser).not.toHaveBeenCalled(); expect(getToken()).toBe("synthetic-existing-account-session");
  });
  it("maps expired or reused codes without echoing the provider token", async () => {
    const recovery = createPasswordRecovery();
    isolated.auth.verifyOtp.mockResolvedValueOnce({ data: {}, error: { code: "otp_expired", message: "bad token 123456" } });
    await expect(recovery.verify(user.email, "123456")).rejects.toThrow("Invalid or expired verification code");
    expect(isolated.auth.updateUser).not.toHaveBeenCalled(); await recovery.dispose();
  });
  it("reports SMTP/provider outages without pretending a code was sent", async () => {
    shared.auth.resetPasswordForEmail.mockResolvedValueOnce({ error: { code: "email_provider_disabled", status: 503 } });
    await expect(requestPasswordReset(user.email)).rejects.toThrow(/email.*unavailable/i);
  });
  it("aborts the isolated transport when recovery is disposed", async () => {
    const transport = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", transport);
    const recovery = createPasswordRecovery();
    await recovery.verify(user.email, "123456");
    const options = (create.mock.calls as unknown[][])[0]![2] as { global: { fetch: typeof fetch } };
    await options.global.fetch("https://example.invalid", {});
    const signal = transport.mock.calls[0]![1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    await recovery.dispose();
    expect(signal.aborted).toBe(true);
  });
  it("closes a timed-out verification without enabling a late password write", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    isolated.auth.verifyOtp.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const recovery = createPasswordRecovery();
    const rejected = expect(recovery.verify(user.email, "123456")).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(15_000); await rejected;
    finish({ data: { user, session: { user, access_token: "synthetic-late" } }, error: null });
    await expect(recovery.updatePassword("new-password-123")).rejects.toThrow(/ended/i);
    expect(isolated.auth.updateUser).not.toHaveBeenCalled();
    expect(getToken()).toBe("synthetic-existing-account-session");
  });
  it("does not write a password when abandoned during the identity check", async () => {
    let finish!: (value: unknown) => void;
    const recovery = createPasswordRecovery(); await recovery.verify(user.email, "123456");
    isolated.auth.getUser.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const rejected = expect(recovery.updatePassword("new-password-123")).rejects.toThrow();
    await recovery.dispose(); finish({ data: { user }, error: null }); await rejected;
    expect(isolated.auth.updateUser).not.toHaveBeenCalled();
  });
});
