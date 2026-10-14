import { expect, it } from "vitest";
import { importedDescriptor, parseImportedCatalogue, validateImportSpec } from "./import";
it("unknown hash/filename never acquires profile or product trust", () => {
  const d = importedDescriptor({ sha256: "a".repeat(64), bytes: 10, format: "gguf", license: "LFM-1.0", fileName: "needle3.cact" });
  expect(d.modelId).toBe("imported-" + "a".repeat(64));
  expect(d.trust).toBe("imported"); expect(d.maturity).toBe("lab"); expect(d.taskRoles).toEqual([]);
  expect(d.fileName).toBe("model.gguf");
});
it.each([
  { sha256: "", bytes: 10, format: "gguf", license: "Apache-2.0" },
  { sha256: "a".repeat(64), bytes: 0, format: "gguf", license: "Apache-2.0" },
  { sha256: "a".repeat(64), bytes: 10, format: "unknown", license: "Apache-2.0" },
  { sha256: "a".repeat(64), bytes: 10, format: "gguf", license: "" },
])("requires explicit exact identity", (s) => { expect(() => validateImportSpec(s)).toThrow(); });

it("routes an explicit LiteRT vision import to the canonical vision runtime without product trust", () => {
  const input = { sha256: "b".repeat(64), bytes: 12, format: "litertlm" as const, modality: "vision" as const, license: "Apache-2.0" };
  const d = importedDescriptor(input);
  expect(d.runtimeId).toBe("smolvlm2-litertlm");
  expect(d.capabilities).toEqual(["vision"]);
  expect(d.taskRoles).toEqual([]);
  expect(d.trust).toBe("imported");
  expect(parseImportedCatalogue(JSON.stringify([input]))[0]).toEqual(d);
});

it.each(["video", "audio", "embedding"])("refuses unsupported imported modality %s", (modality) => {
  expect(() => validateImportSpec({ sha256: "a".repeat(64), bytes: 12, format: "litertlm", modality, license: "Apache-2.0" })).toThrow();
});

it.each(["gguf", "cact"])("does not advertise vision without a supported single-file runtime (%s)", (format) => {
  expect(() => validateImportSpec({ sha256: "a".repeat(64), bytes: 12, format, modality: "vision", license: "Apache-2.0" })).toThrow();
});
