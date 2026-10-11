import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMENT_ATTACH_MAX_BYTES, COMMENT_MEDIA_BUCKET } from "./commentAttachments";

const REPO_ROOT = resolve(process.cwd(), "../..");

function migration(name: string): string {
  return readFileSync(resolve(REPO_ROOT, "supabase", "migrations", name), "utf8");
}

const COMMENT_MEDIA_BUCKET_SQL = migration("20261011030000_comment_media_bucket_policies.sql");
const REPORT_BUCKET_SQL = migration("20260914062145_create_findback_images_bucket.sql");

describe("comment media bucket migration (FBX-013)", () => {
  it("creates a dedicated public bucket sized exactly to the client pre-upload cap", () => {
    const text = COMMENT_MEDIA_BUCKET_SQL;
    expect(text).toMatch(/findback-comment-media/);
    expect(COMMENT_MEDIA_BUCKET).toBe("findback-comment-media");
    // id, name, public=true in that order — the bucket must be public so
    // comment bodies can render these URLs for every viewer.
    expect(text).toMatch(/'findback-comment-media',\s*'findback-comment-media',\s*true,/);
    expect(text).toMatch(new RegExp(String(COMMENT_ATTACH_MAX_BYTES)));
  });

  it("accepts the client video MIME set the report bucket rejects", () => {
    const text = COMMENT_MEDIA_BUCKET_SQL;
    for (const mime of ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime"]) {
      expect(text).toContain(mime);
    }
  });

  it("adds owner-path Storage policies for the new bucket only", () => {
    const text = COMMENT_MEDIA_BUCKET_SQL;
    expect(text).toMatch(/bucket_id = 'findback-comment-media'/);
    expect(text).toMatch(/\(storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/);
    for (const command of ["select", "insert", "delete"]) {
      expect(text).toMatch(new RegExp(`findback_comment_media_${command}_own`, "i"));
    }
  });

  it("never touches the report image bucket (stays 8 MB, images only)", () => {
    // The bucket migration file must not alter the report bucket.
    expect(COMMENT_MEDIA_BUCKET_SQL).not.toMatch(/findback-images/);
    // And the original bucket DDL is byte-still the images-only 8 MB policy.
    const report = REPORT_BUCKET_SQL;
    expect(report).toMatch(/8388608/);
    expect(report).not.toMatch(/video\//);
  });
});

const COMMENT_ATTACHMENTS_SQL = migration("20261011020000_comment_attachments_relation.sql");

/**
 * FBX-014 lifecycle: the typed relation records who attached what to which
 * comment, so provenance is enforceable server-side instead of being
 * inferred from markdown text at render time.
 */
describe("comment attachments relation migration (FBX-014)", () => {
  it("1/8 creates the relation keyed by a text id with a cascading comment FK", () => {
    const text = COMMENT_ATTACHMENTS_SQL;
    expect(text).toMatch(/create table if not exists public\.comment_attachments/i);
    expect(text).toMatch(/id\s+text\s+primary key/i);
    expect(text).toMatch(/comment_id\s+text\s+not null\s+references public\.comments\(id\) on delete cascade/i);
  });

  it("2/8 binds every row to its owner with a cascading user FK", () => {
    const text = COMMENT_ATTACHMENTS_SQL;
    expect(text).toMatch(/user_id\s+text\s+not null\s+references public\.users\(id\) on delete cascade/i);
  });

  it("3/8 restricts kind to the client attachment vocabulary", () => {
    expect(COMMENT_ATTACHMENTS_SQL).toMatch(
      /constraint comment_attachments_kind_check\s+check \(kind in \('photo', 'video', 'gif'\)\)/i,
    );
  });

  it("4/8 keeps display_order bounded and unique per comment", () => {
    const text = COMMENT_ATTACHMENTS_SQL;
    expect(text).toMatch(/display_order\s+integer\s+not null/i);
    expect(text).toMatch(/unique \(comment_id, display_order\)/i);
    expect(text).toMatch(/check \(display_order between 1 and 4\)/i);
  });

  it("5/8 requires exactly one source: a storage path XOR a klipy reference", () => {
    const text = COMMENT_ATTACHMENTS_SQL;
    expect(text).toMatch(/storage_path\s+text/i);
    expect(text).toMatch(/klipy_slug\s+text/i);
    // Exactly-one enforcement: both-null and both-set must be impossible.
    expect(text).toMatch(/constraint comment_attachments_source_xor\s+check/i);
    expect(text).toMatch(/=\s*1\)/);
    expect(text).not.toMatch(/storage_path\s+text\s+not null/i);
    expect(text).not.toMatch(/klipy_slug\s+text\s+not null/i);
  });

  it("6/8 enables RLS with owner-only policies for all four commands", () => {
    const text = COMMENT_ATTACHMENTS_SQL;
    expect(text).toMatch(/alter table public\.comment_attachments enable row level security/i);
    for (const command of ["select", "insert", "update", "delete"]) {
      expect(text).toMatch(new RegExp(`comment_attachments_${command}_own`, "i"));
    }
    const ownerOnly = /user_id = \(select auth\.uid\(\)\)::text/g;
    expect((text.match(ownerOnly) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("7/8 revokes the default ACL and narrows authenticated to row DML", () => {
    const text = COMMENT_ATTACHMENTS_SQL;
    expect(text).toMatch(
      /revoke all on public\.comment_attachments from anon, authenticated/i,
    );
    // Narrow re-grant: row DML only — never truncate/trigger/references.
    expect(text).toMatch(
      /grant select, insert, update, delete on public\.comment_attachments to authenticated/i,
    );
    expect(text).not.toMatch(/grant\s+all\s+on\s+public\.comment_attachments/i);
  });

  it("8/8 lets only the comment's own author attach (insert binds caller to comment)", () => {
    const text = COMMENT_ATTACHMENTS_SQL;
    const insert = /create policy comment_attachments_insert_own[\s\S]*?with check \(([\s\S]*?)\);/i.exec(
      text,
    );
    expect(insert?.[1] ?? "").toMatch(/user_id = \(select auth\.uid\(\)\)::text/);
    expect(insert?.[1] ?? "").toMatch(
      /exists \(select 1 from public\.comments c where c\.id = comment_attachments\.comment_id and c\.user_id = \(select auth\.uid\(\)\)::text\)/i,
    );
  });
});
