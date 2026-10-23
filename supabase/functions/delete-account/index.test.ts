/**
 * delete-account unit tests. Run with `deno test supabase/functions/delete-account/`.
 * Pure orchestration only: fake clients record calls, no network, no secrets.
 *
 * Storage fakes are shrink-on-remove (a successful remove takes the names
 * out of the backing list), which is what the offset-0-until-empty sweep
 * loop relies on; `stallRemove` simulates the silent-no-op remove that the
 * stall guard must catch instead of spinning forever.
 */
import { assert, assertEquals } from "jsr:@std/assert";
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  deleteAuthUser,
  extractBearer,
  handleDelete,
  LAST_ADMIN_DELETION_REFUSAL,
  OWNED_STORAGE_NAMESPACES,
  purgeUserData,
  type DeletionAuth,
  createDeletionHandler,
  deletionClients,
  type DeletionClients,
  type StorageAdmin,
  type TableAdmin,
} from "./index.ts";

interface FakeStorageOptions {
  /** bucket name whose list() fails */
  failList?: string;
  failListAfter?: number;
  /** bucket name whose remove() succeeds but deletes nothing (silent no-op) */
  stallRemove?: string;
}

function fakeStorageApi(
  calls: string[],
  objects: Record<string, string[]>,
  options: FakeStorageOptions = {},
): { from(bucket: string): StorageAdmin } {
  let lists = 0;
  return {
    from(bucket: string): StorageAdmin {
      calls.push(`bucket:${bucket}`);
      return {
        async list(prefix: string, listOptions: { limit: number; offset: number }) {
          calls.push(`list:${bucket}:${prefix}:${listOptions.offset}`);
          if (options.failListAfter !== undefined && ++lists > options.failListAfter) return { data: null, error: { message: "boom" } };
          if (options.failList === bucket) return { data: null, error: { message: "boom" } };
          const matching = (objects[bucket] ?? []).filter((name) => name.startsWith(prefix));
          const children = [...new Set(matching.map((name) => name.slice(prefix.length).split("/")[0]))].sort();
          const page = children.slice(listOptions.offset, listOptions.offset + listOptions.limit);
          return { data: page.map((name) => ({ name, id: matching.includes(`${prefix}${name}`) ? name : null })), error: null };
        },
        async remove(paths: string[]) {
          calls.push(`remove:${bucket}:${paths.join(",")}`);
          if (options.stallRemove === bucket) return { data: [], error: null }; // silent no-op
          objects[bucket] = (objects[bucket] ?? []).filter((name) => !paths.includes(name));
          return { data: paths.map((name) => ({ name })), error: null };
        },
      };
    },
  };
}

function fakeClients(overrides: {
  objects?: Record<string, string[]>;
  failList?: string;
  failListAfter?: number;
  stallRemove?: string;
  usersError?: string;
  getUser?: { id: string } | null;
  getUserError?: string;
  deleteUserError?: string;
  /** The account is the last admin: the pre-flight must refuse the deletion. */
  isLastAdmin?: boolean;
  /** The pre-flight itself is unavailable: the function must fail closed. */
  isLastAdminError?: string;
} = {}): { clients: DeletionClients; calls: string[]; objects: Record<string, string[]> } {
  const calls: string[] = [];
  const objects: Record<string, string[]> = structuredClone(overrides.objects ?? {});
  const storage = fakeStorageApi(calls, objects, {
    failList: overrides.failList,
    failListAfter: overrides.failListAfter,
    stallRemove: overrides.stallRemove,
  });
  const table: TableAdmin = {
    delete: () => ({
      eq: async (column: string, value: string) => {
        calls.push(`users.delete:${column}=${value}`);
        return overrides.usersError ? { error: { message: overrides.usersError } } : { error: null };
      },
    }),
  };
  const auth: DeletionAuth = {
      getUser: async (jwt: string) => {
        calls.push(`getUser:${jwt}`);
        if (overrides.getUserError) return { data: { user: null }, error: { message: overrides.getUserError } };
        return { data: { user: overrides.getUser ?? { id: "u1" } }, error: null };
      },
    admin: {
      deleteUser: async (uid: string) => {
        calls.push(`auth.deleteUser:${uid}`);
        return overrides.deleteUserError ? { error: { message: overrides.deleteUserError } } : { error: null };
      },
    },
  };
  const clients: DeletionClients = {
    beginDeletion: async (uid) => {
      calls.push(`admission:${uid}`);
      if (overrides.isLastAdminError) throw new Error(overrides.isLastAdminError);
      if (overrides.isLastAdmin) return { status: "blocked", user_id: uid, code: "LAST_ADMIN_DELETION_BLOCKED" };
      calls.push(`fence:${uid}`);
      return { status: "admitted", user_id: uid, admission_id: "22222222-2222-4222-8222-222222222222" };
    },
    storage,
    from: (tableName: string) => { calls.push(`table:${tableName}`); return table; },
    auth,
  };
  return { clients, calls, objects };
}

Deno.test("extractBearer accepts a well-formed header and rejects the rest", () => {
  assertEquals(extractBearer("Bearer abc.def.ghi"), "abc.def.ghi");
  assertEquals(extractBearer(null), null);
  assertEquals(extractBearer(""), null);
  assertEquals(extractBearer("Basic abc"), null);
  assertEquals(extractBearer("Bearer "), null);
});

Deno.test("happy path sweeps every owned namespace, then profile row, then auth user in order", async () => {
  const { clients, calls } = fakeClients({
    objects: {
      "findback-images": ["u1/a.jpg", "avatars/u1/av.png"],
      "findback-comment-media": ["u1/c1.jpg"],
    },
  });
  const res = await handleDelete(clients, "Bearer jwt-1");
  assertEquals(res.status, 200);
  assertEquals(res.body, { uid: "u1", storageRemoved: 3, profileDeleted: true, authDeleted: true });
  const order = calls.filter((c) => !c.startsWith("bucket:") && !c.startsWith("table:"));
  assertEquals(order, [
    "getUser:jwt-1",
    // The pre-flight asks the database whether this is the last admin BEFORE
    // the fence is committed and before any byte is swept.
    "admission:u1",
    "fence:u1",
    // Each namespace: remove the page, re-list offset 0, break on empty.
    "list:findback-images:u1/:0",
    "remove:findback-images:u1/a.jpg",
    "list:findback-images:u1/:0",
    "list:findback-images:avatars/u1/:0",
    "remove:findback-images:avatars/u1/av.png",
    "list:findback-images:avatars/u1/:0",
    "list:findback-comment-media:u1/:0",
    "remove:findback-comment-media:u1/c1.jpg",
    "list:findback-comment-media:u1/:0",
    "users.delete:id=u1",
    "auth.deleteUser:u1",
  ]);
});

Deno.test("a full storage page is re-listed at offset 0 (never walks past the first page)", async () => {
  const full = Array.from({ length: 1000 }, (_, i) => `u1/p${i}.jpg`);
  const { clients, calls } = fakeClients({
    objects: { "findback-images": [...full, "u1/tail.jpg"] },
  });
  const res = await handleDelete(clients, "Bearer jwt-1");
  assertEquals(res.status, 200);
  assertEquals(res.body.storageRemoved, 1001);
  const listCalls = calls.filter((c) => c.startsWith("list:"));
  assert(listCalls.every((c) => c.endsWith(":0")), `non-zero list offset: ${listCalls.join(",")}`);
  assert(calls.some((c) => c === "remove:findback-images:u1/tail.jpg"));
  assert(calls.indexOf("remove:findback-images:u1/tail.jpg") < calls.indexOf("users.delete:id=u1"));
});

Deno.test("a silent no-op remove stalls instead of spinning forever", async () => {
  const { clients, calls } = fakeClients({
    objects: { "findback-images": ["u1/a.jpg"] },
    stallRemove: "findback-images",
  });
  const res = await handleDelete(clients, "Bearer jwt-1");
  assertEquals(res.status, 502);
  assert(
    String(res.body.error).includes("stalled"),
    `expected a stall error, got: ${String(res.body.error)}`,
  );
  assertEquals(res.body.storageRemoved, 0);
  assertEquals(res.body.profileDeleted, false);
  assertEquals(res.body.authDeleted, false);
  // Bounded: exactly one list + one remove attempt per round, then throw.
  const lists = calls.filter((c) => c.startsWith("list:findback-images"));
  assertEquals(lists.length, 1, `unconfirmed removal was not stopped immediately: ${calls.join(",")}`);
  assert(!calls.some((c) => c.startsWith("users.delete") || c.startsWith("auth.deleteUser")));
});

Deno.test("a later-namespace list failure carries earlier namespace progress", async () => {
  const { clients } = fakeClients({
    objects: { "findback-images": ["u1/a.jpg", "avatars/u1/av.png"] },
    failList: "findback-comment-media",
  });
  const res = await handleDelete(clients, "Bearer jwt-1");
  assertEquals(res.status, 502);
  assertEquals(res.body, {
    error: "storage list failed: boom",
    code: "ACCOUNT_DELETION_PENDING",
    uid: "u1",
    storageRemoved: 2,
    profileDeleted: false,
    authDeleted: false,
  });
});

Deno.test("every destructive call is scoped to the JWT-resolved uid", async () => {
  const { clients, calls } = fakeClients({
    getUser: { id: "victim" },
    objects: {
      "findback-images": ["victim/x.jpg", "avatars/victim/av.png"],
      "findback-comment-media": ["victim/c.jpg"],
    },
  });
  const res = await handleDelete(clients, "Bearer attacker-jwt");
  assertEquals(res.status, 200);
  assertEquals(res.body.uid, "victim");
  assertEquals(res.body.storageRemoved, 3);
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
  const { clients, calls } = fakeClients({ failList: "findback-images" });
  const res = await handleDelete(clients, "Bearer jwt-1");
  assertEquals(res.status, 502);
  assertEquals(res.body, {
    error: "storage list failed: boom",
    code: "ACCOUNT_DELETION_PENDING",
    uid: "u1",
    storageRemoved: 0,
    profileDeleted: false,
    authDeleted: false,
  });
  assert(!calls.some((c) => c.startsWith("users.delete") || c.startsWith("auth.deleteUser")), calls.join(","));
});

Deno.test("profile-delete failure reports storage progress and skips auth delete", async () => {
  const { clients, calls } = fakeClients({
    objects: { "findback-images": ["u1/a.jpg"] },
    usersError: "db down",
  });
  const res = await handleDelete(clients, "Bearer jwt-1");
  assertEquals(res.status, 502);
  assertEquals(res.body, {
    error: "profile delete failed: db down",
    code: "ACCOUNT_DELETION_PENDING",
    uid: "u1",
    storageRemoved: 1,
    profileDeleted: false,
    authDeleted: false,
  });
  assert(!calls.some((c) => c.startsWith("auth.deleteUser")));
});

Deno.test("auth-delete failure reports the completed purge honestly", async () => {
  const { clients } = fakeClients({ deleteUserError: "admin down" });
  const res = await handleDelete(clients, "Bearer jwt-1");
  assertEquals(res.status, 502);
  assertEquals(res.body, {
    error: "auth delete failed: admin down",
    code: "ACCOUNT_DELETION_PENDING",
    uid: "u1",
    storageRemoved: 0,
    profileDeleted: true,
    authDeleted: false,
  });
});

Deno.test("purgeUserData sweeps all namespaces and the users row", async () => {
  const { clients, calls, objects } = fakeClients({
    objects: {
      "findback-images": ["u9/a.jpg", "u9/b.jpg", "avatars/u9/av.png"],
      "findback-comment-media": ["u9/c1.jpg"],
    },
  });
  const { storageRemoved } = await purgeUserData(clients, "u9");
  assertEquals(storageRemoved, 4);
  assertEquals(objects["findback-images"], []);
  assertEquals(objects["findback-comment-media"], []);
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

Deno.test("registry covers every known user-bytes namespace with uid-scoped trailing-slash prefixes", () => {
  // Coverage rule part 1: the known-writer inventory. If a new writer lands
  // without a registry entry, this is the test that must grow with it.
  const entries = OWNED_STORAGE_NAMESPACES.map((n) => `${n.bucket} :: ${n.prefixFor("probe-uid")}`);
  assertEquals(entries, [
    "findback-images :: probe-uid/",
    "findback-images :: avatars/probe-uid/",
    "findback-comment-media :: probe-uid/",
  ]);
  // Coverage rule part 2: no entry may sweep (or miss) another account.
  for (const namespace of OWNED_STORAGE_NAMESPACES) {
    for (const uid of ["a", "some-uuid-4-like-value", "attacker"]) {
      const prefix = namespace.prefixFor(uid);
      assert(prefix.includes(uid), `prefix for ${uid} does not embed the uid: ${prefix}`);
      assert(prefix.endsWith("/"), `prefix must end with "/": ${prefix}`);
      assert(prefix !== "" && prefix !== "/", `prefix must never be bucket-root: ${prefix}`);
    }
    assert(!namespace.prefixFor("victim").includes("attacker"), "prefix leaked another uid");
  }
});

Deno.test(">2000 objects across pages and namespaces are all swept at offset 0", async () => {
  // 2500 report objects force three 1000-object pages through the same
  // namespace; the avatar and comment namespaces add multi-namespace
  // progress on top. An offset-walking sweeper would orphan objects here
  // (remove shrinks the set under it); offset-0-until-empty must not.
  const many = Array.from({ length: 2500 }, (_, i) => `u7/p${i}.jpg`);
  const { clients, calls, objects } = fakeClients({
    getUser: { id: "u7" },
    objects: {
      "findback-images": [...many, "avatars/u7/av.png"],
      "findback-comment-media": ["u7/c1.jpg", "u7/c2.jpg"],
    },
  });
  const res = await handleDelete(clients, "Bearer jwt-7");
  assertEquals(res.status, 200);
  assertEquals(res.body, { uid: "u7", storageRemoved: 2503, profileDeleted: true, authDeleted: true });
  assertEquals(objects["findback-images"], []);
  assertEquals(objects["findback-comment-media"], []);
  const listCalls = calls.filter((c) => c.startsWith("list:"));
  assert(listCalls.length > 4, `expected several re-lists, got: ${listCalls.join(",")}`);
  assert(listCalls.every((c) => c.endsWith(":0")), `non-zero list offset: ${listCalls.join(",")}`);
  assert(!calls.some((c) => /^list:.*:(?!0$)\d+$/.test(c)), "offset-walk detected");
});

Deno.test("uses the real Supabase auth API boundary, not an invented admin.getUser", async () => {
  const uid = "11111111-1111-4111-8111-111111111111";
  const requests: string[] = [];
  const sdk = createClient("https://example.supabase.co", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = String(input); requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: uid, aud: "authenticated", role: "authenticated", email: "u@example.com" });
      if (url.includes("/rpc/findback_begin_account_deletion")) return Response.json({ status: "admitted", user_id: uid, admission_id: "22222222-2222-4222-8222-222222222222" });
      if (url.includes("/storage/v1/object/list/")) return Response.json([]);
      return Response.json({});
    } },
  });
  const result = await handleDelete(deletionClients(sdk), "Bearer test-jwt");
  assertEquals(result.status, 200, JSON.stringify(result));
  assert(requests.some((request) => request.includes(`/rest/v1/users?id=eq.${uid}`)));
  assert(requests.some((request) => request.includes(`/auth/v1/admin/users/${uid}`)));
});

Deno.test("recursively purges nested objects without touching a sibling account", async () => {
  const { clients, objects } = fakeClients({ objects: {
    "findback-images": ["u1/a.jpg", "u1/sub/deeper/b.jpg", "avatars/u1/nested/avatar.png", "u10/sub/b.jpg"],
    "findback-comment-media": ["u1/sub/a.gif", "u10/a.gif"],
  } });
  const result = await handleDelete(clients, "Bearer jwt");
  assertEquals(result.body.storageRemoved, 4);
  assertEquals(result.status, 200);
  assertEquals(objects["findback-images"], ["u10/sub/b.jpg"]);
  assertEquals(objects["findback-comment-media"], ["u10/a.gif"]);
});

Deno.test("a failure within a namespace retains confirmed first-page progress", async () => {
  const { clients, calls } = fakeClients({ objects: { "findback-images": Array.from({ length: 1001 }, (_, i) => `u1/${i}.jpg`) }, failListAfter: 1 });
  const result = await handleDelete(clients, "Bearer jwt");
  assertEquals(result.status, 502);
  assertEquals(result.body.storageRemoved, 1000);
  assert(!calls.some((call) => call.startsWith("users.delete")));
});

Deno.test("HTTP preflight, method errors and auth errors carry CORS without acquiring admin clients", async () => {
  let acquired = 0;
  const handler = createDeletionHandler(() => { acquired++; throw new Error("must not acquire"); });
  for (const [method, status] of [["OPTIONS", 204], ["GET", 405], ["POST", 401]] as const) {
    const result = await handler(new Request("https://example.test/delete-account", { method }));
    assertEquals(result.status, status);
    assertEquals(result.headers.get("access-control-allow-origin"), "*");
    assert(result.headers.get("access-control-allow-headers")?.includes("authorization"));
  }
  assertEquals(acquired, 0);
});

Deno.test("HTTP authenticated POST confirms all completion flags and invalid session never deletes", async () => {
  const { clients, calls } = fakeClients();
  const handler = createDeletionHandler(() => clients);
  const response = await handler(new Request("https://example.test/delete-account", { method: "POST", headers: { authorization: "Bearer jwt", apikey: "public", origin: "https://findbackapp.social" }, body: '{"uid":"other"}' }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { uid: "u1", storageRemoved: 0, profileDeleted: true, authDeleted: true });
  assert(!calls.some((call) => call.includes("other")));
  assertEquals(response.headers.get("access-control-allow-origin"), "*");
});

Deno.test("paginated nested folders are fully drained without counting folders as objects", async () => {
  const paths = Array.from({ length: 1001 }, (_, i) => `u1/folder${i}/deeper/a.jpg`);
  const { clients, objects } = fakeClients({ objects: { "findback-images": paths } });
  const result = await handleDelete(clients, "Bearer jwt");
  assertEquals(result.status, 200);
  assertEquals(result.body.storageRemoved, 1001);
  assertEquals(objects["findback-images"], []);
});

Deno.test("the last admin is refused BEFORE the fence, the sweep and any delete", async () => {
  // The trigger refuses the last admin at the profile-row delete, but by then
  // the storage fence is committed and every photo, avatar and comment
  // attachment is already swept — and the fence cannot be lifted. So the
  // refusal has to arrive BEFORE the first destructive step.
  const { clients, calls, objects } = fakeClients({
    isLastAdmin: true,
    objects: {
      "findback-images": ["u1/a.jpg", "avatars/u1/av.png"],
      "findback-comment-media": ["u1/c1.jpg"],
    },
  });
  const res = await handleDelete(clients, "Bearer jwt-1");
  assertEquals(res.status, 409);
  assertEquals(res.body, {
    error: LAST_ADMIN_DELETION_REFUSAL,
    code: "LAST_ADMIN_DELETION_BLOCKED",
    uid: "u1",
    storageRemoved: 0,
    profileDeleted: false,
    authDeleted: false,
  });
  // The honest sentence, byte for byte as the database writes it.
  assertEquals(
    res.body.error,
    "This is the only admin account. Promote another admin before deleting this one.",
  );
  // Nothing destructive ran: no fence, no sweep, no row delete.
  assert(!calls.some((c) => c.startsWith("fence:")), `the fence was committed: ${calls.join(",")}`);
  assert(!calls.some((c) => c.startsWith("list:") || c.startsWith("remove:")), `storage was swept: ${calls.join(",")}`);
  assert(!calls.some((c) => c.startsWith("users.delete")), `the profile row was deleted: ${calls.join(",")}`);
  assert(!calls.some((c) => c.startsWith("auth.deleteUser")), `the auth user was deleted: ${calls.join(",")}`);
  // The media is still there.
  assertEquals(objects["findback-images"], ["u1/a.jpg", "avatars/u1/av.png"]);
  assertEquals(objects["findback-comment-media"], ["u1/c1.jpg"]);
  // The pre-flight is the only thing that happened.
  assertEquals(calls, ["getUser:jwt-1", "admission:u1"]);
});

Deno.test("an unavailable pre-flight fails closed instead of deleting anything", async () => {
  const { clients, calls } = fakeClients({
    isLastAdminError: "last-admin check unavailable",
    objects: { "findback-images": ["u1/a.jpg"] },
  });
  const res = await handleDelete(clients, "Bearer jwt-1");
  assertEquals(res.status, 503);
  assert(!calls.some((c) => c.startsWith("fence:")), calls.join(","));
  assert(!calls.some((c) => c.startsWith("list:") || c.startsWith("remove:")), calls.join(","));
  assert(!calls.some((c) => c.startsWith("users.delete") || c.startsWith("auth.deleteUser")), calls.join(","));
});

Deno.test("the adapter asks the database for authoritative admission, not a separate preflight", async () => {
  const uid = "11111111-1111-4111-8111-111111111111";
  const requests: string[] = [];
  const sdk = createClient("https://example.supabase.co", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = String(input); requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: uid, aud: "authenticated", role: "authenticated", email: "u@example.com" });
      if (url.includes("/rest/v1/rpc/findback_begin_account_deletion")) return Response.json({ status: "admitted", user_id: uid, admission_id: "22222222-2222-4222-8222-222222222222" });
      if (url.includes("/storage/v1/object/list/")) return Response.json([]);
      return Response.json({});
    } },
  });
  const result = await handleDelete(deletionClients(sdk), "Bearer test-jwt");
  assertEquals(result.status, 200, JSON.stringify(result));
  assert(requests.some((request) => request.includes("/rest/v1/rpc/findback_begin_account_deletion")));
  assert(!requests.some((request) => request.includes("/rest/v1/rpc/findback_is_last_admin")));
});

Deno.test("the adapter refuses when the database says this is the last admin", async () => {
  const uid = "11111111-1111-4111-8111-111111111111";
  const requests: string[] = [];
  const sdk = createClient("https://example.supabase.co", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = String(input); requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: uid, aud: "authenticated", role: "authenticated", email: "u@example.com" });
      if (url.includes("/rest/v1/rpc/findback_begin_account_deletion")) return Response.json({ status: "blocked", user_id: uid, code: "LAST_ADMIN_DELETION_BLOCKED" });
      if (url.includes("/storage/v1/object/list/")) return Response.json([]);
      return Response.json({});
    } },
  });
  const result = await handleDelete(deletionClients(sdk), "Bearer test-jwt");
  assertEquals(result.status, 409, JSON.stringify(result));
  assertEquals(result.body.error, LAST_ADMIN_DELETION_REFUSAL);
  // Nothing was deleted and nothing was swept.
  assert(!requests.some((request) => request.includes("/rest/v1/users")));
  assert(!requests.some((request) => request.includes("/storage/v1/object/")));
  assert(!requests.some((request) => request.includes("/auth/v1/admin/users/")));
  assertEquals(requests.filter((request) => request.includes("/rest/v1/rpc/findback_begin_account_deletion")).length, 1);
});
