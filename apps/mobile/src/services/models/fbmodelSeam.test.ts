import { describe, expect, it } from "vitest";
import {
  FBMODEL_DENIED_MAGICS,
  FBMODEL_DENIED_SUFFIXES,
  FBMODEL_EXTENSION,
  FBMODEL_PACKAGE_VERSION,
  isFbmodelDeniedSuffix,
} from "./fbmodelSeam";

describe("fbmodel seam (reserved, no implementation)", () => {
  it("pins the package extension and manifest version", () => {
    expect(FBMODEL_EXTENSION).toBe(".fbmodel");
    expect(FBMODEL_PACKAGE_VERSION).toBe("1");
  });

  it("denies executable suffixes case-insensitively", () => {
    expect(isFbmodelDeniedSuffix("payload/model.so")).toBe(true);
    expect(isFbmodelDeniedSuffix("payload/RUN.SH")).toBe(true);
    expect(isFbmodelDeniedSuffix("weights/model.litertlm")).toBe(false);
    expect(isFbmodelDeniedSuffix("tokenizer/vocab.json")).toBe(false);
  });

  it("covers native, package, and script suffixes plus sniff magics", () => {
    expect(FBMODEL_DENIED_SUFFIXES).toContain(".apk");
    expect(FBMODEL_DENIED_SUFFIXES).toContain(".py");
    expect(FBMODEL_DENIED_MAGICS.length).toBeGreaterThan(0);
    const elf = FBMODEL_DENIED_MAGICS[0]!;
    expect([...elf].map((c) => c.charCodeAt(0))).toEqual([0x7f, 0x45, 0x4c, 0x46]);
  });
});
