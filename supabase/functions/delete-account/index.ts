/**
 * delete-account — Supabase Edge Function (FBA-036).
 *
 * Self-serve account deletion. The caller presents their own session JWT
 * (`Authorization: Bearer <jwt>`); the function resolves the uid from that
 * JWT via `auth.getUser()` and deletes ONLY that uid. There is no uid
 * parameter, so one account can never delete another — cross-user deletion
 * is impossible by construction, and RLS is bypassed only through the
 * service-role client inside this function.
 *
 * Purge order (each step scoped to the JWT uid):
 *   1. every owned storage namespace (OWNED_STORAGE_NAMESPACES: legacy
 *      report photos under `findback-images/<uid>/`, avatars under
 *      `findback-images/avatars/<uid>/`, comment attachments under
 *      `findback-comment-media/<uid>/`) — offset-0-until-empty sweep with
 *      a no-progress stall guard;
 *   2. `public.users` row — every user-owned table references it
 *      `on delete cascade` (item_posts, comments, reactions, ratings,
 *      verification_challenges, uploads, notifications, device_tokens,
 *      notification_preferences, push_reply_tokens);
 *   3. the auth user via `auth.admin.deleteUser`.
 *
 * A later step never runs after an earlier failure; the response reports
 * exactly what was removed (`storageRemoved`, `profileDeleted`,
 * `authDeleted`) so partial progress is never presented as complete.
 *
 * Required function environment (set with `supabase secrets set`):
 * - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — injected by the runtime.
 *
 * Pure orchestration (`handleDelete`, `purgeUserData`, `extractBearer`) is
 * dependency-injected for unit tests: `deno test supabase/functions/delete-account/`.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const STORAGE_PAGE_SIZE = 1000;

export interface StorageObject {
  name: string;
}

export interface StorageAdmin {
  list(prefix: string, options: { limit: number; offset: number }): Promise<{
    data: StorageObject[] | null;
    error: { message: string } | null;
  }>;
  remove(paths: string[]): Promise<{ error: { message: string } | null }>;
}

/**
 * Every storage namespace a user's bytes can live in (FBX-023). Registered
 * here so account deletion sweeps ALL of them; a namespace added elsewhere
 * MUST be registered here in the same change, or deletion orphans it.
 *
 * COVERAGE RULE (new bucket/prefix gate, enforced by index.test.ts):
 *   1. Any change that writes user-owned bytes to Storage under a NEW
 *      (bucket, first-prefix-segment) combination MUST append an entry here
 *      in the SAME change — reviewer must reject the change otherwise.
 *      Known-writer inventory: report photos -> ("findback-images", `<uid>/`),
 *      avatars -> ("findback-images", `avatars/<uid>/`), comment media ->
 *      ("findback-comment-media", `<uid>/`).
 *   2. Every prefixFor(uid) MUST embed the uid and MUST end with "/"; a
 *      prefix that is empty, "/", or uid-free would sweep (or miss) another
 *      account's objects and is rejected by test.
 *   3. The sweep lists each namespace at offset 0 until empty (remove
 *      shrinks the set, so re-listing 0 always advances); offset-walking
 *      past page 0 is forbidden — see sweepNamespace and the >2000-object
 *      regression test.
 */
export const OWNED_STORAGE_NAMESPACES: readonly {
  bucket: string;
  prefixFor(uid: string): string;
}[] = [
  { bucket: "findback-images", prefixFor: (uid: string) => `${uid}/` },
  { bucket: "findback-images", prefixFor: (uid: string) => `avatars/${uid}/` },
  { bucket: "findback-comment-media", prefixFor: (uid: string) => `${uid}/` },
];

export interface TableAdmin {
  delete(): {
    eq(column: string, value: string): Promise<{
      error: { message: string } | null;
    }>;
  };
}

export interface AuthAdmin {
  getUser(jwt: string): Promise<{
    data: { user: { id: string } | null };
    error: { message: string } | null;
  }>;
  deleteUser(uid: string): Promise<{ error: { message: string } | null }>;
}

export interface DeletionClients {
  storage: { from(bucket: string): StorageAdmin };
  from(table: string): TableAdmin;
  auth: { admin: AuthAdmin };
}

export interface PurgeResult {
  storageRemoved: number;
  profileDeleted: boolean;
  authDeleted: boolean;
}

/** Extracts the Bearer JWT; null when absent or malformed (never throws). */
export function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Removes every object under `prefix` with an offset-0-until-empty loop:
 * a successful `remove` shrinks the set, so re-listing offset 0 always
 * advances and a page past the first can never be missed (the old
 * offset-walk left orphans whenever remove shrank the set underneath it).
 * The no-progress stall guard trips when a full remove is followed by an
 * identical page — the silent-no-op case that would otherwise spin
 * forever. Throws with the provider message on any list/remove failure.
 */
async function sweepNamespace(bucket: StorageAdmin, prefix: string): Promise<number> {
  let removed = 0;
  let previousPage: string[] | null = null;
  for (;;) {
    const listed = await bucket.list(prefix, { limit: STORAGE_PAGE_SIZE, offset: 0 });
    if (listed.error) throw new Error(`storage list failed: ${listed.error.message}`);
    const names: string[] = (listed.data ?? []).map((o) => o.name);
    if (names.length === 0) break;
    const previous: string[] | null = previousPage;
    const stalled =
      previous !== null &&
      names.length === previous.length &&
      names.every((name, i) => name === previous[i]);
    if (stalled) {
      throw new Error(`storage sweep stalled at ${prefix}: page unchanged after remove`);
    }
    const removedNow = await bucket.remove(names.map((name) => `${prefix}${name}`));
    if (removedNow.error) throw new Error(`storage remove failed: ${removedNow.error.message}`);
    removed += names.length;
    previousPage = names;
  }
  return removed;
}

/**
 * Removes the user's storage objects across every registered namespace and
 * the profile row. Storage first (files are unrecoverable once the row
 * cascades), then the `users` row which cascades every owned table. Throws
 * on the first failure so the caller can report partial progress honestly;
 * the error carries the count already removed so a mid-sweep failure never
 * reads as "nothing was deleted".
 */
export async function purgeUserData(
  clients: DeletionClients,
  uid: string,
): Promise<{ storageRemoved: number }> {
  let storageRemoved = 0;
  try {
    for (const namespace of OWNED_STORAGE_NAMESPACES) {
      storageRemoved += await sweepNamespace(
        clients.storage.from(namespace.bucket),
        namespace.prefixFor(uid),
      );
    }
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error("storage sweep failed"), {
      storageRemoved,
    });
  }
  const deleted = await clients.from("users").delete().eq("id", uid);
  if (deleted.error) {
    // The storage files are already gone: carry the count on the error so
    // the caller reports partial progress instead of zero.
    throw Object.assign(new Error(`profile delete failed: ${deleted.error.message}`), {
      storageRemoved,
    });
  }
  return { storageRemoved };
}

/** Deletes the auth user. Throws with the provider message on failure. */
export async function deleteAuthUser(clients: DeletionClients, uid: string): Promise<void> {
  const { error } = await clients.auth.admin.deleteUser(uid);
  if (error) throw new Error(`auth delete failed: ${error.message}`);
}

export interface DeleteResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Full orchestration: resolve the uid from the JWT, purge, delete auth.
 * Every branch returns an explicit status + body; the uid in the response
 * always echoes the JWT-resolved uid, never a caller-supplied one.
 */
export async function handleDelete(
  clients: DeletionClients,
  authHeader: string | null,
): Promise<DeleteResponse> {
  const jwt = extractBearer(authHeader);
  if (!jwt) return { status: 401, body: { error: "missing credentials" } };
  const { data, error } = await clients.auth.admin.getUser(jwt);
  const uid = data?.user?.id ?? null;
  if (error || !uid) return { status: 401, body: { error: "invalid session" } };
  let storageRemoved = 0;
  try {
    ({ storageRemoved } = await purgeUserData(clients, uid));
  } catch (err) {
    const message = err instanceof Error ? err.message : "purge failed";
    const progress =
      typeof (err as { storageRemoved?: unknown } | null)?.storageRemoved === "number"
        ? (err as { storageRemoved: number }).storageRemoved
        : 0;
    return { status: 502, body: { error: message, uid, storageRemoved: progress, profileDeleted: false, authDeleted: false } };
  }
  try {
    await deleteAuthUser(clients, uid);
  } catch (err) {
    const message = err instanceof Error ? err.message : "auth delete failed";
    return { status: 502, body: { error: message, uid, storageRemoved, profileDeleted: true, authDeleted: false } };
  }
  return { status: 200, body: { uid, storageRemoved, profileDeleted: true, authDeleted: true } };
}

function jsonResponse(response: DeleteResponse): Response {
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}

if (import.meta.main) {
  serve(async (req: Request): Promise<Response> => {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { "content-type": "application/json" },
      });
    }
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !serviceKey) {
      return new Response(JSON.stringify({ error: "server misconfigured" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const clients = createClient(url, serviceKey) as unknown as DeletionClients;
    return jsonResponse(await handleDelete(clients, req.headers.get("authorization")));
  });
}
