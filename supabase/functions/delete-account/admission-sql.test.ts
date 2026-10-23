/** Opt-in disposable-PG integration. No network: real SDK -> psql admission,
 * in-memory Storage transport, actual handleDelete. Never hosted acceptance.
 * Run with --allow-run=psql --allow-env=PGHOST,PGDATABASE on a fresh chain. */
import { assert, assertEquals } from "jsr:@std/assert";
import { createClient } from "npm:@supabase/supabase-js@2";
import { deletionClients, handleDelete } from "./index.ts";

const enabled = Deno.permissions.querySync({ name: "run", command: "psql" }).state === "granted";
const A = "11111111-1111-4111-8111-00000000aa11";
const B = "11111111-1111-4111-8111-00000000bb11";
const C = "11111111-1111-4111-8111-00000000cc11";
const ids = `'${A}','${B}','${C}'`;
async function sql(query: string, expectSuccess = true): Promise<string> {
  const child = new Deno.Command("psql", { args: ["-X", "-qtA", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", query], stdout: "piped", stderr: "piped" }).spawn();
  const result = await child.output();
  const out = new TextDecoder().decode(result.stdout).trim();
  const err = new TextDecoder().decode(result.stderr);
  if (expectSuccess) {
    if (!result.success) throw new Error(err);
  } else assert(!result.success, `expected rejection: ${query}`);
  return expectSuccess ? out : err;
}
async function arrange() {
  await sql(`delete from public.role_invitations where email in ('admissiona@example.test','admissionb@example.test','admissionc@example.test'); delete from public.user_role_capabilities where user_id in (${ids}); delete from public.user_roles where user_id in (${ids}); delete from auth.users where id::text in (${ids}); delete from public.users where id in (${ids}); delete from public.account_deletion_fences where user_id in (${ids}); delete from public.admin_audit_log where target_id in (${ids});
  insert into public.users(id,username,email,phone,password_hash,email_verified,created_at,updated_at) values
  ('${A}','admissiona','admissiona@example.test','+17700000111','x',1,'2026-10-22','2026-10-22'),
  ('${B}','admissionb','admissionb@example.test','+17700000222','x',1,'2026-10-22','2026-10-22'),
  ('${C}','admissionc','admissionc@example.test','+17700000333','x',1,'2026-10-22','2026-10-22');
  insert into public.user_roles(user_id,role,granted_at) values ('${A}','ADMIN','2026-10-22'),('${B}','ADMIN','2026-10-22');`);
}
async function waitFor(condition: string) {
  const end = Date.now() + 8000;
  do {
    if (await sql(`select exists(${condition});`) === "t") return;
    await new Promise((r) => setTimeout(r, 40));
  } while (Date.now() < end);
  throw new Error(`did not observe ${condition}`);
}
function edge(uid: string, options: { hold?: boolean; lost?: boolean; partial?: boolean } = {}) {
  const calls: string[] = [];
  let lost = options.lost;
  let media = true;
  let partial = options.partial;
  const receipts: string[] = [];
  const sdk = createClient("https://example.supabase.co", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = String(input); calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/auth/v1/user")) return Response.json({ id: uid, aud: "authenticated", role: "authenticated" });
      if (url.includes("/rpc/findback_begin_account_deletion")) {
        let raw: string;
        try { raw = await sql(`set application_name='admission_${uid}'; begin; select public.findback_begin_account_deletion('${uid}'); ${options.hold ? "select pg_sleep(4);" : ""} commit;`); }
        catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (/ERROR:\s+42501: This is the only admin account\. Promote another admin before deleting this one\./.test(message) && /DETAIL:\s+LAST_ADMIN_DELETION_BLOCKED/.test(message)) {
            return Response.json({ code: "42501", details: "LAST_ADMIN_DELETION_BLOCKED", message: "This is the only admin account. Promote another admin before deleting this one." }, { status: 403 });
          }
          throw error;
        }
        const receipt = raw.split("\n").find((line) => line.startsWith("{"));
        assert(receipt); receipts.push(receipt);
        if (lost) { lost = false; throw new Error("lost committed admission response"); }
        return Response.json(JSON.parse(receipt));
      }
      if (url.includes("/storage/v1/object/list/")) {
        const body = JSON.parse(String(init?.body));
        if (partial && !media) { partial = false; return Response.json({ message: "storage unavailable" }, { status: 503 }); }
        return Response.json(media && body.prefix === `${uid}/` && url.includes("findback-images") ? [{ name: "photo.jpg", id: "photo" }] : []);
      }
      if (url.includes("/storage/v1/object/")) { media = false; return Response.json([{ name: `${uid}/photo.jpg` }]); }
      if (url.includes("/rest/v1/users")) { await sql(`delete from public.users where id='${uid}';`); return Response.json({}); }
      if (url.includes("/auth/v1/admin/users/")) { await sql(`delete from auth.users where id='${uid}';`); return Response.json({}); }
      return Response.json({});
    } },
  });
  return { run: () => handleDelete(deletionClients(sdk), "Bearer jwt"), calls, receipts };
}
Deno.test({ name: "real atomic admissions serialize before Storage; retries, authority and provenance", ignore: !enabled, fn: async () => {
  assertEquals(Deno.env.get("PGHOST"), "127.0.0.1");
  assert(/^findback_sql_test(?:_[a-z0-9_]+)?$/.test(Deno.env.get("PGDATABASE") ?? ""));
  await arrange();
  const a = edge(A, { hold: true }); const b = edge(B);
  const ar = a.run();
  await waitFor(`select 1 from pg_stat_activity where application_name='admission_${A}' and wait_event='PgSleep'`);
  const br = b.run();
  await waitFor(`select 1 from pg_stat_activity where application_name='admission_${B}' and wait_event='advisory'`);
  const results = await Promise.all([ar, br]);
  assertEquals(results.map((r) => r.status), [200,409]);
  assert(!b.calls.some((c) => /storage\/|rest\/v1\/users|auth\/v1\/admin/.test(c)), b.calls.join("\n"));
  assertEquals(await sql(`select count(*) from public.account_deletion_fences where user_id='${B}';`), "0");
  assertEquals(await sql(`select count(*) from public.admin_audit_log where target_id='${B}';`), "0");
  assertEquals(await sql(`select count(*) from public.user_roles where user_id='${B}' and role='ADMIN';`), "1");
  assertEquals(await sql(`select count(*) from public.admin_audit_log where target_id='${A}' and actor_user_id is null and previous_state->'roles' @> '[{"role":"ADMIN"}]'::jsonb and new_state->>'verified_user_id'='${A}';`), "1");
  await sql(`insert into auth.users(id,email,raw_user_meta_data) values('${B}','admissionb@example.test','{"username":"admissionb","phone":"01810000222"}');`);
  assert((await sql(`delete from auth.users where id='${B}';`, false)).includes("This is the only admin account"));
  assertEquals(await sql(`select count(*) from auth.users where id='${B}';`), "1");
  assertEquals(await sql(`select count(*) from public.users where id='${B}';`), "1");

  await arrange();
  await sql("insert into public.role_invitations(email,role,invited_at) values('admissiona@example.test','ADMIN','2026-10-22');");
  const lost = edge(A, { lost: true });
  assertEquals((await lost.run()).status, 503);
  assert(!lost.calls.some((c) => c.includes("/storage/")));
  assertEquals(await sql(`select count(*) from public.user_roles where user_id='${A}';`), "0");
  // Direct, invitation and capability acquisition cannot recreate a phantom admin.
  for (const query of [
    `insert into public.user_roles(user_id,role,granted_at) values('${A}','ADMIN','2026-10-22')`,
    `insert into public.user_role_capabilities(user_id,capability,granted_at) values('${A}','roles_manage','2026-10-22')`,
    `insert into public.role_invitations(email,role,invited_at) values('admissiona@example.test','ADMIN','2026-10-22')`,
    `set request.jwt.claim.sub='${B}'; select public.findback_role_grant('admissiona@example.test','ADMIN','{}')`,
    `select public.findback_attach_pending_role('${A}','admissiona@example.test')`,
    `insert into public.user_roles(user_id,role,granted_at) values('${C}','MODERATOR','2026-10-22'); update public.user_roles set user_id='${A}' where user_id='${C}'`,
    `insert into public.user_role_capabilities(user_id,capability,granted_at) values('${C}','reports_review','2026-10-22'); update public.user_role_capabilities set user_id='${A}' where user_id='${C}'`,
  ]) assert((await sql(query, false)).includes("deletion is pending"));
  for (const role of ["anon", "authenticated"]) assert((await sql(`set role ${role}; select public.findback_begin_account_deletion('${A}');`, false)).includes("permission denied"));
  assertEquals(JSON.parse(await sql(`set role service_role; select public.findback_begin_account_deletion('${A}');`)).status, "admitted");
  assertEquals((await lost.run()).status, 200);
  assertEquals(lost.receipts[0], lost.receipts[1]);
  assertEquals(await sql(`select count(*) from public.admin_audit_log where target_id='${A}' and action='account_deletion_admitted';`), "1");

  await arrange();
  const partial = edge(A, { partial: true });
  const first = await partial.run();
  assertEquals(first.status, 502); assertEquals(first.body.code, "ACCOUNT_DELETION_PENDING"); assertEquals(first.body.storageRemoved, 1);
  assertEquals(await sql(`select count(*) from public.user_roles where user_id='${A}';`), "0");
  assertEquals(await sql(`select count(*) from public.account_deletion_fences where user_id='${A}' and admission_id is not null;`), "1");
  assertEquals(await sql(`set request.jwt.claim.sub='${A}'; select public.findback_can('roles_manage');`), "f");
  assert((await sql(`insert into storage.objects(bucket_id,name) values('findback-images','${A}/new.jpg');`, false)).includes("account deletion prevents storage writes"));
  assertEquals((await partial.run()).status, 200);

  // Admission vs the remaining admin's canonical revoke queues on D1, then
  // cannot count the departing account as a safety admin.
  await arrange();
  const held = sql(`set application_name='admission_hold'; begin; select public.findback_begin_account_deletion('${A}'); select pg_sleep(4); commit;`);
  await waitFor("select 1 from pg_stat_activity where application_name='admission_hold' and wait_event='PgSleep'");
  const revoke = sql(`set application_name='admission_revoke'; set request.jwt.claim.sub='${B}'; select public.findback_role_revoke('admissionb@example.test');`, false);
  await waitFor("select 1 from pg_stat_activity where application_name='admission_revoke' and wait_event='advisory'");
  await held; assert((await revoke).includes("last admin cannot be revoked"));
  assertEquals(await sql(`select count(*) from public.user_roles where role='ADMIN';`), "1");
  // Bootstrap cannot re-acquire for a fenced allowlisted account even when
  // zero admins exist (operator fixture only, rolled back).
  const bootstrap = await sql(`begin; delete from public.user_roles where user_id='${B}'; insert into public.bootstrap_admins(email,created_at) values('admissiona@example.test','2026-10-22') on conflict do nothing; set request.jwt.claim.sub='${A}'; select public.findback_bootstrap_admin(); rollback;`, false);
  assert(bootstrap.includes("deletion is pending"));

  await arrange();
  const demotionHeld = sql(`set application_name='admission_demote_hold'; begin; select public.findback_begin_account_deletion('${A}'); select pg_sleep(4); commit;`);
  await waitFor("select 1 from pg_stat_activity where application_name='admission_demote_hold' and wait_event='PgSleep'");
  const demotion = sql(`set application_name='admission_demote'; set request.jwt.claim.sub='${B}'; select public.findback_role_grant('admissionb@example.test','MODERATOR','{reports_review}');`, false);
  await waitFor("select 1 from pg_stat_activity where application_name='admission_demote' and wait_event='advisory'");
  await demotionHeld; assert((await demotion).includes("last admin cannot be demoted"));

  // Reverse order: role revoke commits first; queued admission must refuse
  // before ANY fence, audit, role loss or external media work for A.
  await arrange();
  const revokeHeld = sql(`set application_name='revoke_first'; set request.jwt.claim.sub='${A}'; begin; select public.findback_role_revoke('admissionb@example.test'); select pg_sleep(4); commit;`);
  await waitFor("select 1 from pg_stat_activity where application_name='revoke_first' and wait_event='PgSleep'");
  const loser = edge(A); const losing = loser.run();
  await waitFor(`select 1 from pg_stat_activity where application_name='admission_${A}' and wait_event='advisory'`);
  await revokeHeld; assertEquals((await losing).status, 409);
  assert(!loser.calls.some((c) => c.includes("/storage/")));
  assertEquals(await sql(`select count(*) from public.account_deletion_fences where user_id='${A}';`), "0");
  assertEquals(await sql(`select count(*) from public.admin_audit_log where target_id='${A}' and action='account_deletion_admitted';`), "0");
  assertEquals(await sql(`select count(*) from public.user_roles where user_id='${A}' and role='ADMIN';`), "1");
  console.log("PASS real admission race; loser untouched; lost reply/retry stable; partial cleanup pending and unprivileged/upload-fenced; acquisition closed; revoke/demotion both directions serialized; direct auth cascade refused; audit survives profile cascade");
} });

// Each scenario independently exercises the real FK action, not a direct
// attribution UPDATE substituted for a deletion. Fixture writes precede the
// legacy fence (or confirmed admission); no guard is disabled for setup.
for (const kind of ["role", "capability", "invitation", "admitted-invitation"] as const) {
  Deno.test({ name: `attribution: ${kind} cleanup permits admitted profile/auth deletion without reacquisition`, ignore: !enabled, fn: async () => {
    assertEquals(Deno.env.get("PGHOST"), "127.0.0.1");
    assert(/^findback_sql_test(?:_[a-z0-9_]+)?$/.test(Deno.env.get("PGDATABASE") ?? ""));
    for (const road of ["edge", "auth-cascade"] as const) {
      await arrange();
      await sql(`insert into auth.users(id,email,raw_user_meta_data) values('${A}','admissiona@example.test','{"username":"admissiona","phone":"01810000111"}');`);
      if (kind === "role") await sql(`update public.user_roles set granted_by='${A}' where user_id='${B}';`);
      else if (kind === "capability") await sql(`insert into public.user_role_capabilities(user_id,capability,granted_by,granted_at) values('${B}','reports_review','${A}','2026-10-22');`);
      else await sql(`insert into public.role_invitations(email,role,invited_by,invited_at) values('admissionb@example.test','ADMIN','${A}','2026-10-22');`);
      if (kind === "admitted-invitation") {
        await sql(`insert into public.user_roles(user_id,role,granted_at) values('${C}','ADMIN','2026-10-22');`);
        assertEquals(JSON.parse(await sql(`select public.findback_begin_account_deletion('${B}');`)).status, "admitted");
      } else await sql(`insert into public.account_deletion_fences(user_id) values('${B}');`);
      if (road === "edge") {
        const deleting = edge(A);
        const result = await deleting.run();
        assertEquals(result.status, 200, `${kind}: actual Edge failed after sweep: ${JSON.stringify(result)}`);
        assertEquals(result.body.storageRemoved, 1);
        assert(deleting.calls.some((r) => r.startsWith("DELETE ") && r.includes("/storage/")));
      } else {
        assertEquals(JSON.parse(await sql(`select public.findback_begin_account_deletion('${A}');`)).status, "admitted");
        await sql(`delete from auth.users where id='${A}';`);
      }
      assertEquals(await sql(`select count(*) from public.users where id='${A}';`), "0");
      assertEquals(await sql(`select count(*) from auth.users where id='${A}';`), "0");
      assertEquals(await sql(`select count(*) from public.admin_audit_log where target_id='${A}' and action='account_deletion_admitted' and new_state->>'verified_user_id'='${A}';`), "1");
      const table = kind === "role" ? "user_roles" : kind === "capability" ? "user_role_capabilities" : "role_invitations";
      const subject = kind.includes("invitation") ? "email='admissionb@example.test'" : `user_id='${B}'`;
      const attribution = kind.includes("invitation") ? "invited_by" : "granted_by";
      assertEquals(await sql(`select count(*) from public.${table} where ${subject} and ${attribution} is null;`), "1");
      // No-op and attribution-only changes do not grant authority.
      const authorityColumn = kind === "capability" ? "capability" : "role";
      await sql(`update public.${table} set ${authorityColumn}=${authorityColumn} where ${subject}; update public.${table} set ${attribution}=${attribution} where ${subject}; update public.${table} set ${attribution}='${C}' where ${subject};`);
      const authority = kind === "capability" ? "capability='content_hide'" : "role='MODERATOR'";
      assert((await sql(`update public.${table} set ${authority}, ${attribution}=null where ${subject};`, false)).includes("deletion is pending"));
      if (kind.includes("invitation")) {
        assert((await sql(`update public.role_invitations set email='ADMISSIONB@example.test', invited_by=null where ${subject};`, false)).includes("deletion is pending"));
        assert((await sql(`select public.findback_attach_pending_role('${B}','admissionb@example.test');`, false)).includes("deletion is pending"));
        // Retirement is not acquisition; reactivation is, including when
        // disguised alongside harmless attribution cleanup.
        await sql(`update public.role_invitations set revoked_at='2026-10-22' where ${subject};`);
        assert((await sql(`update public.role_invitations set revoked_at=null, invited_by=null where ${subject};`, false)).includes("deletion is pending"));
        await sql(`update public.role_invitations set accepted_at='2026-10-22', revoked_at=null where ${subject};`);
        assert((await sql(`update public.role_invitations set accepted_at=null, invited_by=null where ${subject};`, false)).includes("deletion is pending"));
      }
      assert((await sql(`insert into public.user_role_capabilities(user_id,capability,granted_at) values('${B}','roles_manage','2026-10-22');`, false)).includes("deletion is pending"));
      if (kind === "admitted-invitation") assertEquals(await sql(`select count(*) from public.user_roles where user_id='${B}';`), "0");
      else assertEquals(await sql(`select count(*) from public.user_roles where user_id='${B}' and role='ADMIN';`), "1");
      console.log(`PASS attribution ${kind}/${road}: FK nulled, delete completed, audit retained, authority changes refused`);
    }
  } });
}
