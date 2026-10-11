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
