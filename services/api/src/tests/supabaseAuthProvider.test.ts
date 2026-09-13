import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdapter, type Row, type Store } from "../db/index.js";
import { SqliteStore } from "../db/store/sqliteStore.js";
import type { UserInsert } from "../db/store/types.js";
import { nowIso } from "../domain/helpers.js";
import {
  createSupabaseAdminOperations,
  createSupabaseAuthOperations,
} from "../auth/supabaseAuthClient.js";
import {
  SupabaseAuthProvider,
  SupabaseVerificationNotEnabledError,
  type SupabaseAdminOperations,
  type SupabaseAuthOperations,
  type SupabaseAuthOutcome,
  type SupabaseAuthUser,
  type SupabaseSessionData,
} from "../auth/supabaseAuthProvider.js";
import { getAuthProvider } from "../auth/index.js";

// ---- fakes (fully offline) ----

class FakeStore {
  readonly users = new Map<string, Row>();
  failInsert = false;

  seed(row: { id: string } & Partial<Row>): void {
    const now = nowIso();
    this.users.set(row.id, {
      id: row.id,
      username: row.username ?? `user_${row.id}`,
      email: row.email ?? `${row.id}@example.com`,
      phone: row.phone ?? "01911111111",
      password_hash: row.password_hash ?? "hash",
      email_verified: row.email_verified ?? 0,
      phone_verified: row.phone_verified ?? 0,
      avatar_url: row.avatar_url ?? null,
      created_at: now,
      updated_at: now,
    });
  }

  async findUserById(id: string): Promise<Row | undefined> {
    return this.users.get(id);
  }

  async findUserIdByField(
    field: "username" | "email" | "phone",
    value: string,
  ): Promise<Row | undefined> {
    const lower = value.toLowerCase();
    for (const user of this.users.values()) {
      if (String(user[field]).toLowerCase() === lower) return user;
    }
    return undefined;
  }

  async findUserByIdentifier(identifier: string): Promise<Row | undefined> {
    const lower = identifier.toLowerCase();
    for (const user of this.users.values()) {
      if (
        String(user.username).toLowerCase() === lower ||
        String(user.email).toLowerCase() === lower
      ) {
        return user;
      }
    }
    return undefined;
  }

  async insertUser(row: UserInsert): Promise<void> {
    if (this.failInsert) throw new Error("simulated insert failure");
    this.users.set(row.id, {
      id: row.id,
      username: row.username,
      email: row.email,
      phone: row.phone,
      password_hash: row.password_hash,
      email_verified: 0,
      phone_verified: 0,
      avatar_url: null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }

  async setUserVerified(id: string, field: "email_verified" | "phone_verified"): Promise<void> {
    const user = this.users.get(id);
    if (user) user[field] = 1;
  }
}

function emptyOutcome(): SupabaseAuthOutcome {
  return { user: null, session: null, errorMessage: null };
}

function authOps(overrides: Partial<SupabaseAuthOperations>): SupabaseAuthOperations {
  return {
    signUp: async () => emptyOutcome(),
    signInWithPassword: async () => emptyOutcome(),
    refreshSession: async () => emptyOutcome(),
    getClaims: async () => ({ sub: null, errorMessage: "unused" }),
    resendSignupEmail: async () => ({ errorCode: null, errorMessage: null }),
    verifyEmailOtp: async () => emptyOutcome(),
    ...overrides,
  };
}

function adminOps(overrides: Partial<SupabaseAdminOperations> = {}): SupabaseAdminOperations {
  return {
    deleteUser: async () => ({ errorMessage: null }),
    revokeSession: async () => ({ errorMessage: null }),
    ...overrides,
  };
}

function authUser(id: string, over: Partial<SupabaseAuthUser> = {}): SupabaseAuthUser {
  return { id, email: "person@example.com", emailConfirmedAt: null, ...over };
}

function session(over: Partial<SupabaseSessionData> = {}): SupabaseSessionData {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresIn: 3600,
    expiresAt: 1700000000,
    ...over,
  };
}

let counter = 0;
function regInput() {
  counter += 1;
  return {
    username: `suser_${counter}`,
    email: `suser${counter}@example.com`,
    phone: `0191${String(1000000 + counter)}`,
    password: "password123",
  };
}

function makeProvider(
  store: FakeStore,
  ops: SupabaseAuthOperations,
  admin: SupabaseAdminOperations = adminOps(),
): SupabaseAuthProvider {
  return new SupabaseAuthProvider(ops, admin, store as unknown as Store);
}

// ---- register ----

describe("SupabaseAuthProvider.register", () => {
  it("creates a profile with the Auth UUID and a null password hash, and maps the session", async () => {
    const store = new FakeStore();
    const provider = makeProvider(
      store,
      authOps({
        signUp: async () => ({
          user: authUser("auth-uuid-1"),
          session: session(),
          identitiesCount: 1,
          errorMessage: null,
        }),
      }),
    );

    const input = regInput();
    const result = await provider.register(input);

    expect(result.emailVerificationRequired).toBe(false);
    expect(result.session?.token).toBe("access-1");
    expect(result.session?.refreshToken).toBe("refresh-1");
    expect(result.session?.expiresIn).toBe(3600);
    expect(result.session?.expiresAt).toBe(1700000000);
    expect(result.user.id).toBe("auth-uuid-1");

    const row = store.users.get("auth-uuid-1");
    expect(row?.id).toBe("auth-uuid-1");
    expect(row?.password_hash).toBeNull();
    expect(row?.username).toBe(input.username);
  });

  it("returns a pending-email result when Supabase returns no session", async () => {
    const store = new FakeStore();
    const provider = makeProvider(
      store,
      authOps({
        signUp: async () => ({
          user: authUser("auth-uuid-2"),
          session: null,
          identitiesCount: 1,
          errorMessage: null,
        }),
      }),
    );

    const input = regInput();
    const result = await provider.register(input);

    expect(result.session).toBeNull();
    expect(result.emailVerificationRequired).toBe(true);
    expect(result.email).toBe(input.email);
    expect(store.users.get("auth-uuid-2")?.password_hash).toBeNull();
  });

  it("marks email verified when Supabase reports the email as confirmed", async () => {
    const store = new FakeStore();
    const provider = makeProvider(
      store,
      authOps({
        signUp: async () => ({
          user: authUser("auth-uuid-3", { emailConfirmedAt: "2026-01-01T00:00:00Z" }),
          session: session(),
          identitiesCount: 1,
          errorMessage: null,
        }),
      }),
    );

    const result = await provider.register(regInput());
    expect(result.user.emailVerified).toBe(true);
  });

  it("prechecks public.users uniqueness before calling Supabase", async () => {
    const store = new FakeStore();
    store.seed({ id: "existing", username: "taken_name" });
    const signUpCalls: unknown[] = [];
    const provider = makeProvider(
      store,
      authOps({
        signUp: async (input) => {
          signUpCalls.push(input);
          return emptyOutcome();
        },
      }),
    );

    await expect(
      provider.register({
        username: "taken_name",
        email: "free@example.com",
        phone: "01915555555",
        password: "password123",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(signUpCalls).toHaveLength(0);
  });

  it("rolls back the Auth user when the profile insert fails", async () => {
    const store = new FakeStore();
    store.failInsert = true;
    const deleted: string[] = [];
    const provider = makeProvider(
      store,
      authOps({
        signUp: async () => ({
          user: authUser("auth-uuid-rollback"),
          session: session(),
          identitiesCount: 1,
          errorMessage: null,
        }),
      }),
      adminOps({
        deleteUser: async (id) => {
          deleted.push(id);
          return { errorMessage: null };
        },
      }),
    );

    await expect(provider.register(regInput())).rejects.toMatchObject({ status: 500 });
    expect(deleted).toEqual(["auth-uuid-rollback"]);
  });

  it("does not mask the original failure when rollback itself fails", async () => {
    const store = new FakeStore();
    store.failInsert = true;
    const provider = makeProvider(
      store,
      authOps({
        signUp: async () => ({
          user: authUser("auth-uuid-rollback-2"),
          session: session(),
          identitiesCount: 1,
          errorMessage: null,
        }),
      }),
      adminOps({
        deleteUser: async () => {
          throw new Error("admin unavailable");
        },
      }),
    );

    await expect(provider.register(regInput())).rejects.toMatchObject({ status: 500 });
  });

  it("treats a Supabase-obfuscated existing email as a duplicate without deleting or inserting", async () => {
    const store = new FakeStore();
    let inserted = false;
    store.insertUser = async () => {
      inserted = true;
    };
    const deleted: string[] = [];
    const provider = makeProvider(
      store,
      authOps({
        signUp: async () => ({
          user: authUser("existing-auth-id"),
          session: null,
          identitiesCount: 0,
          errorMessage: null,
        }),
      }),
      adminOps({
        deleteUser: async (id) => {
          deleted.push(id);
          return { errorMessage: null };
        },
      }),
    );

    await expect(provider.register(regInput())).rejects.toMatchObject({ status: 409 });
    expect(inserted).toBe(false);
    expect(deleted).toEqual([]);
  });

  it("maps sign-up duplicate errors to 409", async () => {
    const store = new FakeStore();
    const provider = makeProvider(
      store,
      authOps({
        signUp: async () => ({
          user: null,
          session: null,
          errorCode: "user_already_exists",
          errorMessage: "User already registered",
        }),
      }),
    );

    await expect(provider.register(regInput())).rejects.toMatchObject({ status: 409 });
  });
});

// ---- login ----

describe("SupabaseAuthProvider.login", () => {
  it("resolves a username to the profile email and maps the Supabase session", async () => {
    const store = new FakeStore();
    store.seed({ id: "u1", username: "loginname", email: "login@example.com" });
    const seen: Array<{ email: string; password: string }> = [];
    const provider = makeProvider(
      store,
      authOps({
        signInWithPassword: async (input) => {
          seen.push(input);
          return { user: authUser("u1"), session: session(), errorMessage: null };
        },
      }),
    );

    const result = await provider.login({ identifier: "loginname", password: "password123" });

    expect(seen).toEqual([{ email: "login@example.com", password: "password123" }]);
    expect(result.token).toBe("access-1");
    expect(result.refreshToken).toBe("refresh-1");
    expect(result.expiresIn).toBe(3600);
    expect(result.expiresAt).toBe(1700000000);
    expect(result.user.id).toBe("u1");
  });

  it("maps invalid credentials to 401", async () => {
    const store = new FakeStore();
    store.seed({ id: "u2", username: "l2", email: "l2@example.com" });
    const provider = makeProvider(
      store,
      authOps({
        signInWithPassword: async () => ({
          user: null,
          session: null,
          errorCode: "invalid_credentials",
          errorMessage: "Invalid login credentials",
        }),
      }),
    );

    await expect(
      provider.login({ identifier: "l2", password: "wrong" }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("maps unconfirmed email to 403", async () => {
    const store = new FakeStore();
    store.seed({ id: "u3", username: "l3", email: "l3@example.com" });
    const provider = makeProvider(
      store,
      authOps({
        signInWithPassword: async () => ({
          user: null,
          session: null,
          errorCode: "email_not_confirmed",
          errorMessage: "Email not confirmed",
        }),
      }),
    );

    await expect(
      provider.login({ identifier: "l3", password: "password123" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns 401 for an unknown identifier without calling Supabase", async () => {
    const store = new FakeStore();
    let called = false;
    const provider = makeProvider(
      store,
      authOps({
        signInWithPassword: async () => {
          called = true;
          return emptyOutcome();
        },
      }),
    );

    await expect(
      provider.login({ identifier: "ghost", password: "password123" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(called).toBe(false);
  });
});

// ---- refresh ----

describe("SupabaseAuthProvider.refresh", () => {
  it("passes the refresh token through and maps the new session", async () => {
    const store = new FakeStore();
    store.seed({ id: "u1", username: "refreshable" });
    const seen: string[] = [];
    const provider = makeProvider(
      store,
      authOps({
        refreshSession: async ({ refresh_token }) => {
          seen.push(refresh_token);
          return {
            user: authUser("u1"),
            session: session({ accessToken: "access-2", refreshToken: "refresh-2" }),
            errorMessage: null,
          };
        },
      }),
    );

    const result = await provider.refresh("refresh-1");

    expect(seen).toEqual(["refresh-1"]);
    expect(result.token).toBe("access-2");
    expect(result.refreshToken).toBe("refresh-2");
    expect(result.user.id).toBe("u1");
  });

  it("rejects when the session user has no public profile", async () => {
    const store = new FakeStore();
    const provider = makeProvider(
      store,
      authOps({
        refreshSession: async () => ({
          user: authUser("missing-profile"),
          session: session(),
          errorMessage: null,
        }),
      }),
    );

    await expect(provider.refresh("refresh-1")).rejects.toMatchObject({ status: 401 });
  });

  it("rejects when Supabase returns an error", async () => {
    const store = new FakeStore();
    const provider = makeProvider(
      store,
      authOps({
        refreshSession: async () => ({
          user: null,
          session: null,
          errorCode: "invalid_grant",
          errorMessage: "Invalid Refresh Token",
        }),
      }),
    );

    await expect(provider.refresh("bad")).rejects.toMatchObject({ status: 401 });
  });
});

// ---- validateAccessToken ----

describe("SupabaseAuthProvider.validateAccessToken", () => {
  it("returns the claims subject as userId", async () => {
    const provider = makeProvider(
      new FakeStore(),
      authOps({ getClaims: async () => ({ sub: "user-123", errorMessage: null }) }),
    );

    await expect(provider.validateAccessToken("token")).resolves.toEqual({ userId: "user-123" });
  });

  it("rejects when getClaims reports an error", async () => {
    const provider = makeProvider(
      new FakeStore(),
      authOps({ getClaims: async () => ({ sub: null, errorMessage: "expired" }) }),
    );

    await expect(provider.validateAccessToken("token")).rejects.toMatchObject({ status: 401 });
  });

  it("rejects when claims carry no subject", async () => {
    const provider = makeProvider(
      new FakeStore(),
      authOps({ getClaims: async () => ({ sub: null, errorMessage: null }) }),
    );

    await expect(provider.validateAccessToken("token")).rejects.toMatchObject({ status: 401 });
  });
});

// ---- signOut ----

describe("SupabaseAuthProvider.signOut", () => {
  it("is a no-op without a token", async () => {
    let called = false;
    const provider = makeProvider(
      new FakeStore(),
      authOps({}),
      adminOps({
        revokeSession: async () => {
          called = true;
          return { errorMessage: null };
        },
      }),
    );

    await expect(provider.signOut()).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it("revokes the current session when a token is present", async () => {
    const seen: string[] = [];
    const provider = makeProvider(
      new FakeStore(),
      authOps({}),
      adminOps({
        revokeSession: async (token) => {
          seen.push(token);
          return { errorMessage: null };
        },
      }),
    );

    await expect(provider.signOut("access-token")).resolves.toBeUndefined();
    expect(seen).toEqual(["access-token"]);
  });

  it("swallows revocation failures so logout stays harmless", async () => {
    const provider = makeProvider(
      new FakeStore(),
      authOps({}),
      adminOps({
        revokeSession: async () => ({ errorMessage: "already expired" }),
      }),
    );

    await expect(provider.signOut("access-token")).resolves.toBeUndefined();
  });
});

// ---- email verification (Supabase) ----

describe("SupabaseAuthProvider email verification send", () => {
  it("resends a signup confirmation to a direct email target", async () => {
    const seen: string[] = [];
    const provider = makeProvider(
      new FakeStore(),
      authOps({
        resendSignupEmail: async (email) => {
          seen.push(email);
          return { errorCode: null, errorMessage: null };
        },
      }),
    );

    await expect(
      provider.sendVerificationCode({ channel: "EMAIL", email: "New@Example.com " }),
    ).resolves.toEqual({});
    expect(seen).toEqual(["New@Example.com"]);
  });

  it("resolves the email from the Store when only a userId is given", async () => {
    const store = new FakeStore();
    store.seed({ id: "u1", email: "stored@example.com" });
    const seen: string[] = [];
    const provider = makeProvider(
      store,
      authOps({
        resendSignupEmail: async (email) => {
          seen.push(email);
          return { errorCode: null, errorMessage: null };
        },
      }),
    );

    await provider.sendVerificationCode({ channel: "EMAIL", userId: "u1" });
    expect(seen).toEqual(["stored@example.com"]);
  });

  it("rejects an EMAIL target with neither email nor userId", async () => {
    const provider = makeProvider(new FakeStore(), authOps({}));
    await expect(
      provider.sendVerificationCode({ channel: "EMAIL" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("maps resend rate limiting to 429", async () => {
    const provider = makeProvider(
      new FakeStore(),
      authOps({
        resendSignupEmail: async () => ({
          errorCode: "over_email_send_rate_limit",
          errorMessage: "Email rate limit exceeded",
        }),
      }),
    );

    await expect(
      provider.sendVerificationCode({ channel: "EMAIL", email: "a@example.com" }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("stays silent for unknown emails to avoid enumeration", async () => {
    const provider = makeProvider(
      new FakeStore(),
      authOps({
        resendSignupEmail: async () => ({
          errorCode: "user_not_found",
          errorMessage: "User not found",
        }),
      }),
    );

    await expect(
      provider.sendVerificationCode({ channel: "EMAIL", email: "ghost@example.com" }),
    ).resolves.toEqual({});
  });
});

describe("SupabaseAuthProvider email verification verify", () => {
  it("verifies the OTP, sets email_verified, and returns the first session", async () => {
    const store = new FakeStore();
    store.seed({
      id: "auth-1",
      username: "verify_user",
      email: "verify@example.com",
      email_verified: 0,
      phone_verified: 1,
    });
    const calls: Array<[string, string]> = [];
    const provider = makeProvider(
      store,
      authOps({
        verifyEmailOtp: async (email, token) => {
          calls.push([email, token]);
          return {
            user: authUser("auth-1", { email: "verify@example.com" }),
            session: session({ accessToken: "access-9", refreshToken: "refresh-9" }),
            errorMessage: null,
          };
        },
      }),
    );

    const result = await provider.verifyVerificationCode(
      { channel: "EMAIL", email: "verify@example.com" },
      "123456",
    );

    expect(calls).toEqual([["verify@example.com", "123456"]]);
    expect(result.emailVerified).toBe(true);
    expect(result.phoneVerified).toBe(true);
    expect(result.session?.token).toBe("access-9");
    expect(result.session?.refreshToken).toBe("refresh-9");
    expect(result.session?.expiresIn).toBe(3600);
    expect(result.session?.expiresAt).toBe(1700000000);
    expect(result.session?.user.id).toBe("auth-1");
    expect(store.users.get("auth-1")?.email_verified).toBe(1);
  });

  it("maps invalid or expired OTP to 400", async () => {
    const store = new FakeStore();
    store.seed({ id: "auth-2", email: "v2@example.com" });
    const provider = makeProvider(
      store,
      authOps({
        verifyEmailOtp: async () => ({
          user: null,
          session: null,
          errorCode: "otp_expired",
          errorMessage: "Token has expired or is invalid",
        }),
      }),
    );

    await expect(
      provider.verifyVerificationCode({ channel: "EMAIL", email: "v2@example.com" }, "000000"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a malformed code before calling Supabase", async () => {
    let called = false;
    const provider = makeProvider(
      new FakeStore(),
      authOps({
        verifyEmailOtp: async () => {
          called = true;
          return emptyOutcome();
        },
      }),
    );

    await expect(
      provider.verifyVerificationCode({ channel: "EMAIL", email: "a@example.com" }, "12"),
    ).rejects.toMatchObject({ status: 400 });
    expect(called).toBe(false);
  });

  it("rejects when no session is returned", async () => {
    const store = new FakeStore();
    store.seed({ id: "auth-3", email: "v3@example.com" });
    const provider = makeProvider(
      store,
      authOps({
        verifyEmailOtp: async () => ({
          user: authUser("auth-3", { email: "v3@example.com" }),
          session: null,
          errorMessage: null,
        }),
      }),
    );

    await expect(
      provider.verifyVerificationCode({ channel: "EMAIL", email: "v3@example.com" }, "123456"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects when the Auth user id is missing", async () => {
    const provider = makeProvider(
      new FakeStore(),
      authOps({
        verifyEmailOtp: async () => ({
          user: null,
          session: session(),
          errorMessage: null,
        }),
      }),
    );

    await expect(
      provider.verifyVerificationCode({ channel: "EMAIL", email: "a@example.com" }, "123456"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects when the public profile is missing", async () => {
    const provider = makeProvider(
      new FakeStore(),
      authOps({
        verifyEmailOtp: async () => ({
          user: authUser("no-profile", { email: "a@example.com" }),
          session: session(),
          errorMessage: null,
        }),
      }),
    );

    await expect(
      provider.verifyVerificationCode({ channel: "EMAIL", email: "a@example.com" }, "123456"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects an email mismatch and does not verify the profile", async () => {
    const store = new FakeStore();
    store.seed({ id: "victim", email: "victim@example.com", email_verified: 0 });
    const provider = makeProvider(
      store,
      authOps({
        verifyEmailOtp: async () => ({
          user: authUser("victim", { email: "victim@example.com" }),
          session: session(),
          errorMessage: null,
        }),
      }),
    );

    await expect(
      provider.verifyVerificationCode(
        { channel: "EMAIL", email: "attacker@example.com" },
        "123456",
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(store.users.get("victim")?.email_verified).toBe(0);
  });
});

// ---- phone verification stays unsupported ----

describe("SupabaseAuthProvider phone verification", () => {
  it("reports sendVerificationCode as not enabled", async () => {
    const provider = makeProvider(new FakeStore(), authOps({}));
    await expect(
      provider.sendVerificationCode({ channel: "PHONE", userId: "u1" }),
    ).rejects.toBeInstanceOf(SupabaseVerificationNotEnabledError);
  });

  it("reports verifyVerificationCode as not enabled", async () => {
    const provider = makeProvider(new FakeStore(), authOps({}));
    await expect(
      provider.verifyVerificationCode({ channel: "PHONE", userId: "u1" }, "123456"),
    ).rejects.toBeInstanceOf(SupabaseVerificationNotEnabledError);
  });
});

// ---- production adapters (SDK shape mapping, still offline) ----

describe("Supabase Auth adapters", () => {
  it("normalizes a password sign-in response", async () => {
    const client = {
      auth: {
        signInWithPassword: async () => ({
          data: {
            user: { id: "u", email: "e@example.com", email_confirmed_at: null, identities: [] },
            session: {
              access_token: "a",
              refresh_token: "r",
              expires_in: 60,
              expires_at: 99,
            },
          },
          error: null,
        }),
      },
    } as unknown as SupabaseClient;

    const outcome = await createSupabaseAuthOperations(client).signInWithPassword({
      email: "e@example.com",
      password: "p",
    });

    expect(outcome.session).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresIn: 60,
      expiresAt: 99,
    });
    expect(outcome.user).toEqual({ id: "u", email: "e@example.com", emailConfirmedAt: null });
    expect(outcome.identitiesCount).toBe(0);
  });

  it("extracts sub from getClaims and rejects when absent", async () => {
    const client = {
      auth: {
        getClaims: async (jwt: string) =>
          jwt === "good"
            ? {
                data: { claims: { sub: "abc" }, header: {}, signature: new Uint8Array() },
                error: null,
              }
            : { data: { claims: {}, header: {}, signature: new Uint8Array() }, error: null },
      },
    } as unknown as SupabaseClient;

    const ops = createSupabaseAuthOperations(client);
    expect(await ops.getClaims("good")).toEqual({ sub: "abc", errorMessage: null });
    expect(await ops.getClaims("no-sub")).toEqual({ sub: null, errorMessage: null });
  });

  it("revokes only the current session (local scope)", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const client = {
      auth: {
        admin: {
          signOut: async (jwt: string, scope?: string) => {
            calls.push([jwt, scope]);
            return { error: null };
          },
        },
      },
    } as unknown as SupabaseClient;

    await createSupabaseAdminOperations(client).revokeSession("jwt-token");
    expect(calls).toEqual([["jwt-token", "local"]]);
  });

  it("resends the signup confirmation with type signup", async () => {
    const calls: Array<{ type: string; email: string }> = [];
    const client = {
      auth: {
        resend: async (params: { type: string; email: string }) => {
          calls.push(params);
          return { data: { user: null, session: null, messageId: "m" }, error: null };
        },
      },
    } as unknown as SupabaseClient;

    const result = await createSupabaseAuthOperations(client).resendSignupEmail(
      "person@example.com",
    );
    expect(calls).toEqual([{ type: "signup", email: "person@example.com" }]);
    expect(result).toEqual({ errorCode: null, errorMessage: null });
  });

  it("verifies the email OTP with type email and normalizes the session", async () => {
    const calls: Array<{ email: string; token: string; type: string }> = [];
    const client = {
      auth: {
        verifyOtp: async (params: { email: string; token: string; type: string }) => {
          calls.push(params);
          return {
            data: {
              user: { id: "u", email: "e@example.com", email_confirmed_at: "now", identities: [] },
              session: { access_token: "a", refresh_token: "r", expires_in: 60, expires_at: 99 },
            },
            error: null,
          };
        },
      },
    } as unknown as SupabaseClient;

    const outcome = await createSupabaseAuthOperations(client).verifyEmailOtp(
      "e@example.com",
      "123456",
    );
    expect(calls).toEqual([{ email: "e@example.com", token: "123456", type: "email" }]);
    expect(outcome.session?.accessToken).toBe("a");
    expect(outcome.user?.id).toBe("u");
  });
});

// ---- selector unchanged ----

describe("getAuthProvider selector", () => {
  it("still selects LocalAuthProvider in this block", () => {
    expect(getAuthProvider().constructor.name).toBe("LocalAuthProvider");
  });
});

// ---- SQLite guard ----

describe("Store password_hash contract", () => {
  it("keeps requiring a non-null password hash for local/SQLite auth", async () => {
    const store = new SqliteStore(getAdapter());
    const now = nowIso();
    await expect(
      store.insertUser({
        id: "sqlite-guard",
        username: "sqlite_guard",
        email: "sqlite_guard@example.com",
        phone: "01919999999",
        password_hash: null,
        created_at: now,
        updated_at: now,
      }),
    ).rejects.toThrow(/password_hash is required/);
  });
});
