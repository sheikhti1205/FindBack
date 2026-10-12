import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IMPORT_MAX_INPUT_BYTES, oversizedInputMessage } from "./importImage";
import { MAX_ORIGINAL_BYTES, PhotoImportError, SOURCE_LIMIT_MESSAGE, normalizeForUpload } from "../photo";
import { ACCEPTED_STILL_FORMATS_LABEL, ACCEPTED_STILL_MIME_TYPES, MAX_EDGE, MAX_DERIVATIVE_BYTES, PROBE_BYTES, SOURCE_MAX_BYTES, UPLOAD_MAX_BYTES, isAcceptedStillMime, isWithinSourceCap } from "./mediaPolicy";

/**
 * FBX-004: ONE semantic source cap across the JS intake path and the Android
 * native processor (com.findback.app.media.MediaPolicy.MAX_SOURCE_BYTES).
 * 99 MiB reaches preparation; 100 MiB + 1 is refused before any decode or
 * source-sized allocation. Derivative caps are separate and never inherit
 * from the source cap. The JVM half of this contract is
 * MediaPolicyTest.sourceCapMatchesTheJsIntakePath.
 */
describe("media policy source cap", () => {
  it("is the single 100 MiB source bound shared by every intake path", () => {
    expect(SOURCE_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_ORIGINAL_BYTES).toBe(SOURCE_MAX_BYTES);
    expect(IMPORT_MAX_INPUT_BYTES).toBe(SOURCE_MAX_BYTES);
  });

  it("keeps derivative caps separate from the source cap", () => {
    expect(MAX_DERIVATIVE_BYTES).toBeLessThan(SOURCE_MAX_BYTES);
    expect(UPLOAD_MAX_BYTES).toBeLessThan(SOURCE_MAX_BYTES);
    expect(MAX_EDGE).toBe(1920);
    expect(PROBE_BYTES).toBe(65_536);
  });

  it("accepts 99 MiB and the cap itself, rejects one byte more", () => {
    // 99 MiB reaches preparation; the cap itself is still accepted.
    expect(isWithinSourceCap(99 * 1024 * 1024)).toBe(true);
    expect(isWithinSourceCap(SOURCE_MAX_BYTES)).toBe(true);
    expect(isWithinSourceCap(SOURCE_MAX_BYTES + 1)).toBe(false);
    expect(isWithinSourceCap(-1)).toBe(false);
    expect(isWithinSourceCap(Number.NaN)).toBe(false);
  });

  it("refuses an oversized source with the shared user-facing copy before decoding", async () => {
    const oversized = new File([new Uint8Array(0)], "big.jpg", { type: "image/jpeg" });
    Object.defineProperty(oversized, "size", { value: SOURCE_MAX_BYTES + 1 });
    await expect(normalizeForUpload(oversized)).rejects.toBeInstanceOf(PhotoImportError);
    await expect(normalizeForUpload(oversized)).rejects.toThrow(oversizedInputMessage("big.jpg", SOURCE_MAX_BYTES + 1));
    await expect(normalizeForUpload(oversized)).rejects.toThrow("100 MB");
  });

  it("lets a 99 MiB source reach preparation instead of the source-cap refusal", async () => {
    // 99 MiB is inside the cap: normalizeForUpload must NOT throw the
    // source-limit copy. The empty test payload may fail later decode/read
    // stages — any such error proves the source-cap gate was passed.
    const justUnder = new File([new Uint8Array(0)], "big.jpg", { type: "image/jpeg" });
    Object.defineProperty(justUnder, "size", { value: 99 * 1024 * 1024 });
    const err = await normalizeForUpload(justUnder).then(() => null, (e: unknown) => e);
    // Either preparation succeeded or it failed at a LATER stage (decode/read):
    // the refusal must never be either shape of the source-cap message.
    const msg = err instanceof Error ? err.message : "";
    expect(err === null || (msg !== SOURCE_LIMIT_MESSAGE && !/intake cap/.test(msg))).toBe(true);
  });
});

/**
 * The guard pattern carries a `[G]` character class purely so this file never
 * trips its own scan: it hunts hand-written advertised-list sentences
 * everywhere outside mediaPolicy.ts, and this test file is outside
 * mediaPolicy.ts. (This comment must not contain the hunted sentence.)
 */
const HAND_WRITTEN_ADVERTISEMENT = /Choose a JPE[G]/;

/** The sentence, lowercased, split into its individual container names. */
const labelTokens = ACCEPTED_STILL_FORMATS_LABEL.toLowerCase().replace(", or ", ", ").split(", ");

/** `image/jpg` is a JPEG alias, not a ninth container. */
function baseOf(mimeType: string): string {
  const base = mimeType.replace(/^image\//, "");
  return base === "jpg" ? "jpeg" : base;
}

/**
 * FBX-003: ONE advertised accepted-container list. The rejection copy and the
 * accept maps must agree — a container that intake accepts is advertised, and
 * a container that is advertised is accepted. The label is a single exported
 * constant so the sentence and the map cannot drift again.
 */
describe("accepted still formats label (FBX-003)", () => {
  it("advertises exactly the containers the real accept maps accept", () => {
    const photoSource = readFileSync(new URL("../photo.ts", import.meta.url), "utf8");
    const reportSource = readFileSync(new URL("../../screens/CreateReport.tsx", import.meta.url), "utf8");

    // Real map 1 — photo.ts `FALLBACK_ACCEPTED_KINDS = new Set([...])`.
    const fallbackBlock = photoSource.match(/FALLBACK_ACCEPTED_KINDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    expect(fallbackBlock).not.toBe("");
    const fallbackKinds = [...fallbackBlock.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!.replace(/-animated$/, ""));
    expect(fallbackKinds.length).toBeGreaterThan(0);
    for (const kind of new Set(fallbackKinds)) expect(labelTokens).toContain(kind);

    // Real map 2 — photo.ts's sniffed-kind -> MIME ternary chain.
    const mimeChain = photoSource.match(/const mime = ([\s\S]*?) : null;/)?.[1] ?? "";
    expect(mimeChain).not.toBe("");
    const sniffedMimes = [...mimeChain.matchAll(/"(image\/[a-z]+)"/g)].map((m) => m[1]!);
    expect(sniffedMimes.length).toBeGreaterThan(0);
    for (const mime of new Set(sniffedMimes)) expect(labelTokens).toContain(baseOf(mime));
    for (const kind of new Set([...mimeChain.matchAll(/kind === "([a-z-]+)"/g)].map((m) => m[1]!.replace(/-animated$/, "")))) {
      expect(labelTokens).toContain(kind);
    }

    // Real map 3 — CreateReport's transport gate reads the canonical policy
    // (L-CONSOLIDATE: no local ACCEPTED_IMAGE_TYPES list — the accept map,
    // the gate predicate, and the byte ceiling all alias the canonicals).
    expect(reportSource).toMatch(
      /import \{[^}]*ACCEPTED_STILL_MIME_TYPES[^}]*isAcceptedStillMime[^}]*UPLOAD_MAX_BYTES[^}]*\} from "\.\.\/services\/media\/mediaPolicy"/,
    );
    expect(reportSource).not.toMatch(/const ACCEPTED_IMAGE_TYPES = \[/);
    expect(reportSource).not.toMatch(/const MAX_IMAGE_BYTES = 8 \* 1024 \* 1024/);
    const acceptedAlias = reportSource.match(/const ACCEPTED_IMAGE_TYPES[^=]*=\s*([^\n;]*)/)?.[1] ?? "";
    expect(acceptedAlias).toContain("ACCEPTED_STILL_MIME_TYPES");
    for (const mime of ACCEPTED_STILL_MIME_TYPES) expect(labelTokens).toContain(baseOf(mime));
    // …and the reverse: every advertised container really is accepted there
    // (by construction — the alias IS the canonical list).
    for (const token of labelTokens) expect(ACCEPTED_STILL_MIME_TYPES.some((mime) => baseOf(mime) === token)).toBe(true);
  });

  it("ties the exported MIME list to the sentence in both directions", () => {
    expect(ACCEPTED_STILL_MIME_TYPES.length).toBeGreaterThan(0);
    for (const mime of ACCEPTED_STILL_MIME_TYPES) expect(labelTokens).toContain(baseOf(mime));
    for (const token of labelTokens) expect(ACCEPTED_STILL_MIME_TYPES.some((mime) => baseOf(mime) === token)).toBe(true);
    expect(isAcceptedStillMime("image/heic")).toBe(true);
    expect(isAcceptedStillMime("image/tiff")).toBe(false);
    expect(isAcceptedStillMime("")).toBe(false);
  });

  it("is the single source of the advertised set in the intake services", () => {
    const photoSource = readFileSync(new URL("../photo.ts", import.meta.url), "utf8");
    const importSource = readFileSync(new URL("./importImage.ts", import.meta.url), "utf8");
    expect(photoSource).toContain("ACCEPTED_STILL_FORMATS_LABEL");
    expect(importSource).toContain("ACCEPTED_STILL_FORMATS_LABEL");
    // No hand-written advertised list may survive beside the shared label.
    expect(photoSource).not.toMatch(/pick a JPEG, PNG/);
    expect(importSource).not.toMatch(/pick a JPEG, PNG/);
    expect(importSource).not.toMatch(/recognized photo \(JPEG/);
  });

  it("has no hand-written advertised list anywhere outside mediaPolicy.ts", () => {
    const srcRoot = fileURLToPath(new URL("../..", import.meta.url));
    const offenders: string[] = [];
    for (const rel of readdirSync(srcRoot, { recursive: true, encoding: "utf8" }) as string[]) {
      if (!/\.tsx?$/.test(rel)) continue;
      const path = join(srcRoot, rel);
      if (basename(path) === "mediaPolicy.ts") continue;
      if (HAND_WRITTEN_ADVERTISEMENT.test(readFileSync(path, "utf8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
