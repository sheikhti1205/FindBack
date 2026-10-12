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
import {
  deleteAuthUser,
  extractBearer,
  handleDelete,
  OWNED_STORAGE_NAMESPACES,
  purgeUserData,
  type AuthAdmin,
  type DeletionClients,
  type StorageAdmin,
  type TableAdmin,
} from "./index.ts";

interface FakeStorageOptions {
  /** bucket name whose list() fails */
  failList?: string;
  /** bucket name whose remove() succeeds but deletes nothing (silent no-op) */
  stallRemove?: string;
}

function fakeStorageApi(
  calls: string[],
  objects: Record<string, string[]>,
  options: FakeStorageOptions = {},
): { from(bucket: string): StorageAdmin } {
  return {
    from(bucket: string): StorageAdmin {
      calls.push(`bucket:${bucket}`);
      return {
        async list(prefix: string, listOptions: { limit: number; offset: number }) {
          calls.push(`list:${bucket}:${prefix}:${listOptions.offset}`);
          if (options.failList === bucket) return { data: null, error: { message: "boom" } };
          const matching = (objects[bucket] ?? []).filter((name) => name.startsWith(prefix));
          const page = matching.slice(listOptions.offset, listOptions.offset + listOptions.limit);
          return { data: page.map((name) => ({ name: name.slice(prefix.length) })), error: null };
        },
        async remove(paths: string[]) {
          calls.push(`remove:${bucket}:${paths.join(",")}`);
          if (options.stallRemove === bucket) return { error: null }; // silent no-op
          objects[bucket] = (objects[bucket] ?? []).filter((name) => !paths.includes(name));
          return { error: null };
        },
      };
    },
  };
}

function fakeClients(overrides: {
  objects?: Record<string, string[]>;
  failList?: string;
  stallRemove?: string;
  usersError?: string;
  getUser?: { id: string } | null;
  getUserError?: string;
  deleteUserError?: string;
} = {}): { clients: DeletionClients; calls: string[]; objects: Record<string, string[]> } {
  const calls: string[] = [];
  const objects: Record<string, string[]> = structuredClone(overrides.objects ?? {});
  const storage = fakeStorageApi(calls, objects, {
    failList: overrides.failList,
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
  assertEquals(lists.length, 2, `stall guard did not trip after one re-list: ${calls.join(",")}`);
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
