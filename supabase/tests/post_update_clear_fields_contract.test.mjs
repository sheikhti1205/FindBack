/** Focused control-flow/merge guard. Engine execution is separate evidence. */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const normalize = (source) => source.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
const sql = normalize(readFileSync(new URL("../migrations/20261022103000_post_update_clear_fields.sql", import.meta.url), "utf8"));

function assertContract(source) {
  const code = normalize(source);
  const requires = [
    "returns boolean language plpgsql security invoker set search_path = public, pg_temp",
    "v_uid text := auth.uid()::text;",
    "if v_uid is null then raise exception 'Not authenticated' using errcode = '28000'; end if;",
    "if p_clear_fields is not null then foreach v_requested in array p_clear_fields loop v_requested := lower(btrim(coalesce(v_requested, '')));",
    "if v_requested = 'location_label' then v_clear_location := true; elsif v_requested = 'latitude' or v_requested = 'longitude' then v_clear_coords := true;",
    "elsif v_requested = 'type' or v_requested = 'title' or v_requested = 'description' or v_requested = 'category' or v_requested = 'event_date' then raise exception 'Field % is required on every report and cannot be cleared', v_requested using errcode = '22023'; else raise exception 'Unknown field to clear: %', v_requested using errcode = '22023'; end if; end loop; end if;",
    "if v_clear_coords and (p_latitude is not null or p_longitude is not null) then raise exception 'Cannot clear the location coordinates and set new coordinates in the same call' using errcode = '22023'; end if;",
    "select type, title, description, category, event_date, latitude, longitude, location_label, youtube_url into v_existing from public.item_posts where id = p_post_id and user_id = v_uid; if not found then raise exception 'Post not found or you do not own it' using errcode = '42501'; end if;",
    "v_merged_type := coalesce(p_type, v_existing.type);",
    "v_merged_category := coalesce(p_category, v_existing.category);",
    ...["title", "description", "event_date", "youtube_url"].map((field) =>
      `v_merged_${field} := coalesce(nullif(btrim(coalesce(p_${field}, '')), ''), v_existing.${field});`),
    ...["latitude", "longitude"].map((field) =>
      `v_merged_${field} := case when v_clear_coords then null else coalesce(p_${field}, v_existing.${field}) end;`),
    "v_merged_location_label := case when v_clear_location and nullif(btrim(coalesce(p_location_label, '')), '') is null then null else coalesce(nullif(btrim(coalesce(p_location_label, '')), ''), v_existing.location_label) end;",
    `v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');`,
    `update public.item_posts set ${["type", "title", "description", "category", "event_date", "latitude", "longitude", "location_label", "youtube_url"].map((f) => `${f} = v_merged_${f}`).join(", ")}, updated_at = v_now where id = p_post_id and user_id = v_uid;`,
    "get diagnostics v_count = row_count; if v_count = 0 then raise exception 'Post not found or you do not own it' using errcode = '42501'; end if; return true;",
  ];
  for (const expected of requires) assert.ok(code.includes(expected), `missing contract: ${expected}`);
  // No later override can turn an otherwise-preserved branch into a no-op.
  assert.equal((code.match(/\bv_uid\s*(?:text\s*)?:=/g) ?? []).length, 1, "the session is the only ownership source");
  assert.equal((code.match(/v_clear_location :=/g) ?? []).length, 1);
  assert.equal((code.match(/v_clear_coords :=/g) ?? []).length, 1);
  for (const field of ["type", "title", "description", "category", "event_date", "latitude", "longitude", "location_label", "youtube_url"]) {
    assert.equal((code.match(new RegExp(`v_merged_${field} :=`, "g")) ?? []).length, 1);
  }
}

test("all merged values, owner filters and refusal branches retain their executable contract", () => assertContract(sql));

const mutations = [
  ["row-derived ownership source", "v_uid text := auth.uid()::text;", "v_uid text := (select user_id from public.item_posts where id = p_post_id);"],
  ["later ownership override", "if v_uid is null then", "v_uid := (select user_id from public.item_posts where id = p_post_id); if v_uid is null then"],
  ["erase YouTube", "coalesce(nullif(btrim(coalesce(p_youtube_url, '')), ''), v_existing.youtube_url)", "null"],
  ["erase type", "coalesce(p_type, v_existing.type)", "coalesce(p_type, null)"],
  ["erase date", "coalesce(nullif(btrim(coalesce(p_event_date, '')), ''), v_existing.event_date)", "null"],
  ["ignore explicit label", "else coalesce(nullif(btrim(coalesce(p_location_label, '')), ''), v_existing.location_label)", "else null"],
  ["label clear no-op", "v_clear_location := true", "v_clear_location := false"],
  ["pin clear no-op", "v_clear_coords := true", "v_clear_coords := false"],
  ["ignore unknown name", "else raise exception 'Unknown field", "elsif false then raise exception 'Unknown field"],
  ["missing auth refusal", "if v_uid is null then", "if false then"],
  ["null array breaks callers", "in array p_clear_fields loop", "in array coalesce(p_clear_fields, array['title']) loop"],
  ["dead conflict refusal", "if v_clear_coords and", "if false and v_clear_coords and"],
  ["weaken SELECT owner", "where id = p_post_id and user_id = v_uid;", "where id = p_post_id;"],
  ["weaken UPDATE owner", /where id = p_post_id and user_id = v_uid;(?=\s*get diagnostics)/, "where id = p_post_id;"],
  ["dead row-count refusal", "if v_count = 0 then", "if v_count = -1 then"],
  ["wrong language", "language plpgsql", "language sql"],
  ["drop normalization", "lower(btrim(coalesce(v_requested, '')))", "v_requested"],
  ["erase timestamp", "updated_at = v_now", "updated_at = null"],
  ["false success", "return true;", "return false;"],
];
for (const [label, before, after] of mutations) test(`rejects mutation: ${label}`, () => {
  const mutated = sql.replace(before, after);
  assert.ok(mutated !== sql, "mutation must actually change executable bytes");
  assert.throws(() => assertContract(mutated));
});
