import { describe, expect, it } from "vitest";
import { AuthRefreshUnsupportedError, getAuthProvider } from "../auth/index.js";
import { verifyToken } from "../domain/authService.js";

let counter = 0;

function freshPayload(prefix: string) {
  counter += 1;
  const suffix = `${Date.now().toString(36)}${counter}`;
  const phone = `019${String(Math.floor(10000000 + Math.random() * 89999999))}`;
  return {
    username: `${prefix}_${suffix}`.slice(0, 20),
    email: `${prefix}${suffix}@example.com`,
    phone,
    password: "password123",
  };
}

describe("AuthProvider contract (local)", () => {
  it("register returns a session and no email-confirmation gate", async () => {
    const result = await getAuthProvider().register(freshPayload("reg"));

    expect(result.emailVerificationRequired).toBe(false);
    expect(result.session).not.toBeNull();
    expect(result.session?.token).toBeTruthy();
    expect(result.session?.refreshToken).toBeUndefined();
    expect(result.session?.expiresIn).toBeUndefined();
    expect(result.session?.expiresAt).toBeUndefined();
    expect(result.user.id).toBeTruthy();
    expect(result.session?.user).toEqual(result.user);
  });

  it("register token is the existing local JWT for the new user", async () => {
    const result = await getAuthProvider().register(freshPayload("jwt"));
    expect(verifyToken(result.session!.token)).toEqual({ userId: result.user.id });
  });

  it("login returns a session with the same JWT semantics", async () => {
    const payload = freshPayload("login");
    const registered = await getAuthProvider().register(payload);
    const session = await getAuthProvider().login({
      identifier: payload.username,
      password: payload.password,
    });

    expect(session.token).toBeTruthy();
    expect(session.user.id).toBe(registered.user.id);
    expect(session.refreshToken).toBeUndefined();
    expect(session.expiresIn).toBeUndefined();
    expect(session.expiresAt).toBeUndefined();
    expect(verifyToken(session.token)).toEqual({ userId: registered.user.id });
  });

  it("verification returns flags without a session", async () => {
    const registered = await getAuthProvider().register(freshPayload("verify"));
    const send = await getAuthProvider().sendVerificationCode(
      registered.user.id,
      "EMAIL",
    );
    expect(send.devCode).toMatch(/^\d{6}$/);

    const result = await getAuthProvider().verifyVerificationCode(
      registered.user.id,
      "EMAIL",
      send.devCode!,
    );
    expect(result.emailVerified).toBe(true);
    expect(result.phoneVerified).toBe(false);
    expect(result.session).toBeUndefined();
  });

  it("refresh explicitly reports unsupported behavior", async () => {
    await expect(getAuthProvider().refresh("irrelevant")).rejects.toBeInstanceOf(
      AuthRefreshUnsupportedError,
    );
  });

  it("signOut resolves with and without an access token", async () => {
    await expect(getAuthProvider().signOut()).resolves.toBeUndefined();
    await expect(getAuthProvider().signOut("any-token")).resolves.toBeUndefined();
  });
});
