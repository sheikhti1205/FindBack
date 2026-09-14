import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { PublicUser } from "@findback/shared";
import { app } from "./helpers.js";
import { AppError } from "../domain/helpers.js";
import {
  setAuthProviderForTests,
  type AuthProvider,
  type AuthSession,
} from "../auth/index.js";

const USER: PublicUser = {
  id: "11111111-1111-1111-1111-111111111111",
  username: "cutover_user",
  email: "cutover@example.com",
  phone: "01812345678",
  emailVerified: false,
  phoneVerified: false,
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const SESSION: AuthSession = {
  token: "access-token-1",
  refreshToken: "refresh-token-1",
  expiresIn: 3600,
  expiresAt: 9_999_999_999,
  user: USER,
};

function provider(overrides: Partial<AuthProvider> = {}): AuthProvider {
  return {
    register: async () => ({
      user: USER,
      session: null,
      emailVerificationRequired: true,
      email: USER.email,
    }),
    login: async () => SESSION,
    refresh: async () => SESSION,
    validateAccessToken: async () => ({ userId: USER.id }),
    signOut: async () => {},
    sendVerificationCode: async () => ({}),
    verifyVerificationCode: async () => ({
      emailVerified: true,
      phoneVerified: false,
      session: SESSION,
    }),
    ...overrides,
  };
}

afterEach(() => setAuthProviderForTests(null));

describe("POST /auth/register (Supabase pending + immediate)", () => {
  it("returns a pending-email union with no token", async () => {
    setAuthProviderForTests(provider());
    const res = await request(app)
      .post("/auth/register")
      .send({ username: "newbie", email: "newbie@example.com", phone: "01812345678", password: "password123" })
      .expect(201);
    expect(res.body).toEqual({
      user: USER,
      emailVerificationRequired: true,
      email: USER.email,
    });
    expect(res.body.token).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
  });

  it("returns a full session when registration authenticates immediately", async () => {
    setAuthProviderForTests(
      provider({
        register: async () => ({
          user: USER,
          session: SESSION,
          emailVerificationRequired: false,
        }),
      }),
    );
    const res = await request(app)
      .post("/auth/register")
      .send({ username: "newbie", email: "newbie@example.com", phone: "01812345678", password: "password123" })
      .expect(201);
    expect(res.body.token).toBe("access-token-1");
    expect(res.body.refreshToken).toBe("refresh-token-1");
    expect(res.body.expiresIn).toBe(3600);
    expect(res.body.expiresAt).toBe(9_999_999_999);
    expect(res.body.emailVerificationRequired).toBe(false);
  });
});

describe("POST /auth/login", () => {
  it("exposes the rotating session fields", async () => {
    setAuthProviderForTests(provider());
    const res = await request(app)
      .post("/auth/login")
      .send({ identifier: "cutover_user", password: "password123" })
      .expect(200);
    expect(res.body.token).toBe("access-token-1");
    expect(res.body.refreshToken).toBe("refresh-token-1");
    expect(res.body.expiresIn).toBe(3600);
    expect(res.body.user.id).toBe(USER.id);
  });
});

describe("POST /auth/refresh", () => {
  it("exchanges a refresh token for a new session", async () => {
    setAuthProviderForTests(
      provider({
        refresh: async (token) => {
          if (token !== "refresh-token-1") throw new AppError(401, "Invalid or expired refresh token");
          return { ...SESSION, token: "access-token-2", refreshToken: "refresh-token-2" };
        },
      }),
    );
    const res = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: "refresh-token-1" })
      .expect(200);
    expect(res.body.token).toBe("access-token-2");
    expect(res.body.refreshToken).toBe("refresh-token-2");
  });

  it("maps an unsupported provider to 501", async () => {
    // Real LocalAuthProvider (singleton reset): stateless JWTs cannot refresh.
    const res = await request(app)
      .post("/auth/refresh")
      .send({ refreshToken: "whatever" })
      .expect(501);
    expect(res.body.error).toMatch(/refresh/i);
  });

  it("rejects a missing refresh token", async () => {
    await request(app).post("/auth/refresh").send({}).expect(400);
  });
});

describe("public pending-signup email verification", () => {
  it("sends a generic success with no dev code", async () => {
    setAuthProviderForTests(provider());
    const res = await request(app)
      .post("/auth/email-verification/send")
      .send({ email: USER.email })
      .expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.body.devCode).toBeUndefined();
  });

  it("maps rate limiting to 429", async () => {
    setAuthProviderForTests(
      provider({
        sendVerificationCode: async () => {
          throw new AppError(429, "Too many resend attempts. Please wait and try again");
        },
      }),
    );
    await request(app)
      .post("/auth/email-verification/send")
      .send({ email: USER.email })
      .expect(429);
  });

  it("rejects a malformed email", async () => {
    setAuthProviderForTests(provider());
    await request(app)
      .post("/auth/email-verification/send")
      .send({ email: "not-an-email" })
      .expect(400);
  });

  it("returns the session + verified flags without leaking internals", async () => {
    setAuthProviderForTests(provider());
    const res = await request(app)
      .post("/auth/email-verification/verify")
      .send({ email: USER.email, code: "123456" })
      .expect(200);
    expect(res.body.token).toBe("access-token-1");
    expect(res.body.refreshToken).toBe("refresh-token-1");
    expect(res.body.emailVerified).toBe(true);
    expect(res.body.phoneVerified).toBe(false);
    expect(res.body.session).toBeUndefined();
    expect(res.body.password).toBeUndefined();
    expect(res.body.password_hash).toBeUndefined();
  });

  it("maps an invalid OTP to 400", async () => {
    setAuthProviderForTests(
      provider({
        verifyVerificationCode: async () => {
          throw new AppError(400, "Invalid or expired verification code");
        },
      }),
    );
    await request(app)
      .post("/auth/email-verification/verify")
      .send({ email: USER.email, code: "000000" })
      .expect(400);
  });

  it("rejects a too-short code before calling the provider", async () => {
    setAuthProviderForTests(provider());
    await request(app)
      .post("/auth/email-verification/verify")
      .send({ email: USER.email, code: "12345" })
      .expect(400);
  });

  it("accepts the project's configured 8-digit OTP length", async () => {
    let seen = "";
    setAuthProviderForTests(
      provider({
        verifyVerificationCode: async (_target, code) => {
          seen = code;
          return { emailVerified: true, phoneVerified: false, session: SESSION };
        },
      }),
    );
    await request(app)
      .post("/auth/email-verification/verify")
      .send({ email: USER.email, code: "35072827" })
      .expect(200);
    expect(seen).toBe("35072827");
  });

  it("fails safely when verification returns no session", async () => {
    setAuthProviderForTests(
      provider({
        verifyVerificationCode: async () => ({ emailVerified: true, phoneVerified: false }),
      }),
    );
    await request(app)
      .post("/auth/email-verification/verify")
      .send({ email: USER.email, code: "123456" })
      .expect(400);
  });
});
