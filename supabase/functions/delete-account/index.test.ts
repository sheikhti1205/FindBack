/**
 * delete-account unit tests. Run with `deno test supabase/functions/delete-account/`.
 * Pure orchestration only: fake clients record calls, no network, no secrets.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import {
  deleteAuthUser,
  extractBearer,
  handleDelete,
  purgeUserData,
  type AuthAdmin,
  type DeletionClients,
  type StorageAdmin,
  type TableAdmin,
} from "./index.ts";

function fakeStorage(
  calls: string[],
  pages: string[][] = [[]],
  failList?: string,
): StorageAdmin {
  return {
    async list(prefix: string, options: { limit: number; offset: number }) {
      calls.push(`list:${prefix}:${options.offset}`);
      if (failList) return { data: null, error: { message: failList } };
      return { data: (pages[options.offset / 1000] ?? []).map((name) => ({ name })), error: null };
    },
    async remove(paths: string[]) {
      calls.push(`remove:${paths.join(",")}`);
      return { error: null };
    },
  };
}

function fakeClients(overrides: {
  pages?: string[][];
  storageError?: string;
  usersError?: string;
  getUser?: { id: string } | null;
  getUserError?: string;
  deleteUserError?: string;
} = {}): { clients: DeletionClients; calls: string[] } {
  const calls: string[] = [];
  const storage = fakeStorage(calls, overrides.pages, overrides.storageError);
  const table: TableAdmin = {
    delete: () => ({
      eq: async (column: string, value: string) => {
        calls.push(`users.delete:${column}=${value}`);
        return overrides.usersError ? { error: { message: overrides.usersError } } : { error: null };
      },
    }),
  };
  const auth: { admin: AuthAdmin } = {
    admin: {
      getUser: async (jwt: string) => {
        calls.push(`getUser:${jwt}`);
        if (overrides.getUserError) return { data: { user: null }, error: { message: overrides.getUserError } };
        return { data: { user: overrides.getUser ?? { id: "u1" } }, error: null };
      },
      deleteUser: async (uid: string) => {
        calls.push(`auth.deleteUser:${uid}`);
        return overrides.deleteUserError ? { error: { message: overrides.deleteUserError } } : { error: null };
      },
    },
  };
  const clients: DeletionClients = {
    storage: { from: (bucket: string) => { calls.push(`bucket:${bucket}`); return storage; } },
    from: (tableName: string) => { calls.push(`table:${tableName}`); return table; },
    auth,
  };
  return { clients, calls };
}

Deno.test("extractBearer accepts a well-formed header and rejects the rest", () => {
  assertEquals(extractBearer("Bearer abc.def.ghi"), "abc.def.ghi");
  assertEquals(extractBearer(null), null);
  assertEquals(extractBearer(""), null);
  assertEquals(extractBearer("Basic abc"), null);
  assertEquals(extractBearer("Bearer "), null);
});

Deno.test("happy path purges storage, profile row, then auth user in order", async () => {
  const { clients, calls } = fakeClients({ pages: [["a.jpg"]] });
  const res = await handleDelete(clients, "Bearer jwt-1");
  assertEquals(res.status, 200);
  assertEquals(res.body, { uid: "u1", storageRemoved: 1, profileDeleted: true, authDeleted: true });
  const order = calls.filter((c) => !c.startsWith("bucket:") && !c.startsWith("table:"));
  assertEquals(order, [
    "getUser:jwt-1",
    "list:u1:0",
    "remove:u1/a.jpg",
    "users.delete:id=u1",
    "auth.deleteUser:u1",
  ]);
});

Deno.test("a full storage page continues pagination at the next offset", async () => {
  const full = Array.from({ length: 1000 }, (_, i) => `p${i}.jpg`);
  const { clients, calls } = fakeClients({ pages: [full, ["tail.jpg"]] });
  const res = await handleDelete(clients, "Bearer jwt-1");
  assertEquals(res.status, 200);
  assertEquals(res.body.storageRemoved, 1001);
  assert(calls.includes("list:u1:0"));
  assert(calls.includes("list:u1:1000"));
  assert(calls.includes("remove:u1/tail.jpg"));
  assert(calls.indexOf("list:u1:1000") < calls.indexOf("users.delete:id=u1"));
});

Deno.test("every destructive call is scoped to the JWT-resolved uid", async () => {
  const { clients, calls } = fakeClients({ getUser: { id: "victim" }, pages: [["x.jpg"]] });
  const res = await handleDelete(clients, "Bearer attacker-jwt");
  assertEquals(res.status, 200);
  assertEquals(res.body.uid, "victim");
  for (const call of calls) {
    if (call.startsWith("getUser:") || call.startsWith("bucket:") || call.startsWith("table:")) continue;
    assert(call.includes("victim"), `call escaped the JWT uid: ${call}`);
    assert(!call.includes("attacker"), `call used attacker input: ${call}`);
  }
});

Deno.test("missing or invalid session returns 401 with zero destructive calls", async () => {
  for (const header of [null, "Basic xyz", "Bearer "]) {
    const { clients, calls } = fakeClients();
    const res = await handleDelete(clients, header);
    assertEquals(res.status, 401);
    assertEquals(calls, [], `destructive-capable calls ran for header ${header}`);
  }
  const expired = fakeClients({ getUser: null, getUserError: "expired" });
  const res = await handleDelete(expired.clients, "Bearer stale");
  assertEquals(res.status, 401);
  assertEquals(expired.calls, ["getUser:stale"]);
});

Deno.test("storage failure aborts before the profile row or auth user is touched", async () => {
  const { clients, calls } = fakeClients({ storageError: "boom" });
  const res = await handleDelete(clients, "Bearer jwt-1");
  assertEquals(res.status, 502);
  assertEquals(res.body, {
    error: "storage list failed: boom",
    uid: "u1",
    storageRemoved: 0,
    profileDeleted: false,
    authDeleted: false,
  });
  assert(!calls.some((c) => c.startsWith("users.delete") || c.startsWith("auth.deleteUser")), calls.join(","));
});

Deno.test("profile-delete failure reports storage progress and skips auth delete", async () => {
  const { clients, calls } = fakeClients({ pages: [["a.jpg"]], usersError: "db down" });
  const res = await handleDelete(clients, "Bearer jwt-1");
  assertEquals(res.status, 502);
  assertEquals(res.body, {
    error: "profile delete failed: db down",
    uid: "u1",
    storageRemoved: 1,
    profileDeleted: false,
    authDeleted: false,
  });
  assert(!calls.some((c) => c.startsWith("auth.deleteUser")));
});

Deno.test("auth-delete failure reports the completed purge honestly", async () => {
  const { clients } = fakeClients({ pages: [[]], deleteUserError: "admin down" });
  const res = await handleDelete(clients, "Bearer jwt-1");
  assertEquals(res.status, 502);
  assertEquals(res.body, {
    error: "auth delete failed: admin down",
    uid: "u1",
    storageRemoved: 0,
    profileDeleted: true,
    authDeleted: false,
  });
});

Deno.test("purgeUserData removes every page and the users row", async () => {
  const { clients, calls } = fakeClients({ pages: [["a.jpg", "b.jpg"], []] });
  const { storageRemoved } = await purgeUserData(clients, "u9");
  assertEquals(storageRemoved, 2);
  assert(calls.includes("users.delete:id=u9"));
});

Deno.test("deleteAuthUser throws with the provider message", async () => {
  const { clients } = fakeClients({ deleteUserError: "nope" });
  let message = "";
  try {
    await deleteAuthUser(clients, "u1");
  } catch (err) {
    message = err instanceof Error ? err.message : "";
  }
  assertEquals(message, "auth delete failed: nope");
});
