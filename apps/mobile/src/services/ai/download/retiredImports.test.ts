import { expect, it } from "vitest";
import { parseRetiredImportedModels } from "./retiredImports";

it.each(["gguf", "litertlm", "cact"])("legacy %s metadata produces only frozen cleanup identities", (format) => {
  const [descriptor] = parseRetiredImportedModels(JSON.stringify([{
    sha256: "d".repeat(64), bytes: 12, format, license: "Apache-2.0",
    fileName: "needle3.cact", url: "https://models.example.org/old-model",
  }]));
  expect(descriptor).toMatchObject({
    modelId: `imported-${"d".repeat(64)}`, revision: "d".repeat(64),
    fileName: `model.${format}`, sha256: "d".repeat(64), bytes: 12,
    trust: "imported", cleanupOnly: true, downloadable: false, importable: false, taskRoles: [],
  });
  expect(Object.isFrozen(descriptor)).toBe(true);
});

it("preserves the old single-file vision path without providing a vision engine", () => {
  const [d] = parseRetiredImportedModels(JSON.stringify([{
    sha256: "b".repeat(64), bytes: 12, format: "litertlm", modality: "vision", license: "Apache-2.0",
  }]));
  expect(d).toMatchObject({ fileName: "model.litertlm", cleanupOnly: true, taskRoles: [] });
});

it.each([
  { sha256: "", bytes: 10, format: "gguf", license: "Apache-2.0" },
  { sha256: "a".repeat(64), bytes: 0, format: "gguf", license: "Apache-2.0" },
  { sha256: "a".repeat(64), bytes: 10, format: "unknown", license: "Apache-2.0" },
  { sha256: "a".repeat(64), bytes: 10, format: "gguf", license: "" },
  { sha256: "a".repeat(64), bytes: 10, format: "gguf", license: "Apache-2.0", url: "file:///private" },
  ...["video", "audio", "embedding"].map((modality) => ({ sha256: "a".repeat(64), bytes: 12, format: "litertlm", modality, license: "Apache-2.0" })),
  ...["gguf", "cact"].map((format) => ({ sha256: "a".repeat(64), bytes: 12, format, modality: "vision", license: "Apache-2.0" })),
])("refuses unsafe or ambiguous legacy identity %j", (record) => {
  expect(parseRetiredImportedModels(JSON.stringify([record]))).toEqual([]);
});

it.each([null, "not json", "{}", JSON.stringify(Array(65).fill({}))])("ignores malformed/oversized metadata: %s", (text) => {
  expect(parseRetiredImportedModels(text)).toEqual([]);
});
