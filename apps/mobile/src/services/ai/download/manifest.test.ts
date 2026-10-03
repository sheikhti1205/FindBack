/**
 * WS-C manifest validation tests (TDD): one case per rejection rule.
 *
 * No network, no filesystem, no model binaries: pure validation of
 * untrusted manifest records.
 */
import { describe, expect, it } from "vitest";
import {
  ManifestValidationError,
  collectManifestErrors,
  validateManifest,
} from "./manifest";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function validManifest(): Record<string, unknown> {
  return {
    modelId: "qwen3-0.6b",
    revision: "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76",
    runtime: "llama-cpp",
    quant: "Q4_0",
    license: "Apache-2.0",
    files: [
      {
        path: "weights/model.gguf",
        url: "https://cdn.example.com/models/model.gguf",
        sha256: SHA_A,
        sizeBytes: 600_000_000,
      },
    ],
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestValidationError);
    return (error as ManifestValidationError).code;
  }
  throw new Error("expected validateManifest to throw");
}

describe("model manifest validation", () => {
  it("accepts a well-formed manifest and sums totalBytes", () => {
    const manifest = validateManifest(validManifest());
    expect(manifest.totalBytes).toBe(600_000_000);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.runtime).toBe("llama-cpp");
  });

  it("rejects hash-missing pins", () => {
    const input = validManifest();
    (input["files"] as Record<string, unknown>[])[0] = {
      path: "weights/model.gguf",
      url: "https://cdn.example.com/models/model.gguf",
      sizeBytes: 10,
    };
    expect(codeOf(() => validateManifest(input))).toBe("HASH_MISSING");
  });

  it("rejects malformed (non-hex) pins as hash-missing", () => {
    const input = validManifest();
    ((input["files"] as Record<string, unknown>[])[0] as Record<string, unknown>)["sha256"] =
      "not-a-hash";
    expect(codeOf(() => validateManifest(input))).toBe("HASH_MISSING");
  });

  it("rejects non-https URL schemes", () => {
    const input = validManifest();
    ((input["files"] as Record<string, unknown>[])[0] as Record<string, unknown>)["url"] =
      "http://cdn.example.com/models/model.gguf";
    expect(codeOf(() => validateManifest(input))).toBe("BAD_URL_SCHEME");
  });

  it("rejects unknown runtimes", () => {
    const input = { ...validManifest(), runtime: "cuda-graphs-v9" };
    expect(codeOf(() => validateManifest(input))).toBe("UNKNOWN_RUNTIME");
  });

  it("rejects size mismatch between totalBytes and file sum", () => {
    const input = { ...validManifest(), totalBytes: 1 };
    expect(codeOf(() => validateManifest(input))).toBe("SIZE_MISMATCH");
  });

  it("rejects non-positive file sizes", () => {
    const input = validManifest();
    ((input["files"] as Record<string, unknown>[])[0] as Record<string, unknown>)["sizeBytes"] = 0;
    expect(codeOf(() => validateManifest(input))).toBe("SIZE_MISMATCH");
  });

  it("rejects license-missing manifests", () => {
    const input = { ...validManifest(), license: "  " };
    expect(codeOf(() => validateManifest(input))).toBe("LICENSE_MISSING");
  });

  it("rejects path traversal entries", () => {
    for (const bad of ["../evil.gguf", "/abs/model.gguf", "a/../../b", "win\\evil.gguf", ""]) {
      const input = validManifest();
      ((input["files"] as Record<string, unknown>[])[0] as Record<string, unknown>)["path"] = bad;
      expect(codeOf(() => validateManifest(input))).toBe("PATH_TRAVERSAL");
    }
  });

  it("rejects duplicate file paths", () => {
    const input = validManifest();
    const file = (input["files"] as unknown[])[0];
    input["files"] = [file, { ...(file as Record<string, unknown>) }];
    expect(codeOf(() => validateManifest(input))).toBe("DUPLICATE_FILE");
  });

  it("rejects quant mismatch (unknown manifest quant)", () => {
    const input = { ...validManifest(), quant: "FP8_MADE_UP" };
    expect(codeOf(() => validateManifest(input))).toBe("QUANT_MISMATCH");
  });

  it("rejects quant mismatch (file quant differs from manifest)", () => {
    const input = validManifest();
    ((input["files"] as Record<string, unknown>[])[0] as Record<string, unknown>)["quant"] = "F16";
    expect(codeOf(() => validateManifest(input))).toBe("QUANT_MISMATCH");
  });

  it("rejects revision-missing manifests", () => {
    const input = { ...validManifest(), revision: "" };
    expect(codeOf(() => validateManifest(input))).toBe("REVISION_MISSING");
  });

  it("collectManifestErrors returns the typed error without throwing", () => {
    const input = { ...validManifest(), revision: "" };
    const { manifest, errors } = collectManifestErrors(input);
    expect(manifest).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("REVISION_MISSING");
    void SHA_B;
  });
});
