import { assertEquals, assert } from "jsr:@std/assert";
import { createClient } from "npm:@supabase/supabase-js@2";
import { deletionClients, handleDelete } from "./index.ts";

const uid = "11111111-1111-4111-8111-111111111111";
const admission = { status: "admitted", user_id: uid, admission_id: "22222222-2222-4222-8222-222222222222" };
function sdkReply(reply: unknown, lost = false, rpcStatus = 200) {
  const requests: string[] = [];
  const sdk = createClient("https://example.supabase.co", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = String(input); requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: uid, aud: "authenticated", role: "authenticated" });
      if (url.includes("/rpc/findback_is_last_admin")) return Response.json(false);
      if (url.includes("/rpc/findback_begin_account_deletion")) {
        if (lost) throw new Error("lost acknowledgement after commit");
        return Response.json(reply, { status: rpcStatus });
      }
      if (url.includes("/storage/v1/object/list/")) return Response.json([]);
      return Response.json({});
    } },
  });
  return { clients: deletionClients(sdk), requests };
}
for (const reply of [null, true, "admitted", [], {}, { ...admission, user_id: "other" }, { ...admission, admission_id: null }, { ...admission, code: "LAST_ADMIN_DELETION_BLOCKED" }, { status: "blocked", user_id: uid, code: "UNKNOWN" }]) {
  Deno.test(`malformed admission ${JSON.stringify(reply)} never authorizes a sweep`, async () => {
    const { clients, requests } = sdkReply(reply);
    const result = await handleDelete(clients, "Bearer jwt");
    assertEquals(result.status, 503);
    assert(!requests.some((r) => /storage\/|rest\/v1\/users|auth\/v1\/admin/.test(r)), requests.join("\n"));
  });
}
Deno.test("lost admission acknowledgement never speculates; retry confirms reservation", async () => {
  const first = sdkReply(admission, true);
  assertEquals((await handleDelete(first.clients, "Bearer jwt")).status, 503);
  assert(!first.requests.some((r) => r.includes("/storage/")));
  const retry = sdkReply(admission);
  assertEquals((await handleDelete(retry.clients, "Bearer jwt")).status, 200);
});
Deno.test("typed admission refusal has zero progress and no destructive requests", async () => {
  const { clients, requests } = sdkReply({ status: "blocked", code: "LAST_ADMIN_DELETION_BLOCKED", user_id: uid });
  const result = await handleDelete(clients, "Bearer jwt");
  assertEquals(result.status, 409);
  assertEquals(result.body.code, "LAST_ADMIN_DELETION_BLOCKED");
  assertEquals(result.body.storageRemoved, 0);
  assert(!requests.some((r) => /storage\/|rest\/v1\/users|auth\/v1\/admin/.test(r)));
});
for (const known of [true, false]) {
  Deno.test(`real SDK SQL refusal is narrowly classified known=${known}`, async () => {
    const { clients, requests } = sdkReply({ code: "42501", details: known ? "LAST_ADMIN_DELETION_BLOCKED" : "unknown", message: "This is the only admin account. Promote another admin before deleting this one." }, false, 403);
    const result = await handleDelete(clients, "Bearer jwt");
    assertEquals(result.status, known ? 409 : 503);
    assert(!requests.some((r) => /storage\/|rest\/v1\/users|auth\/v1\/admin/.test(r)));
  });
}
