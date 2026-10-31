/**
 * Frozen upgrade-cleanup identities from the former curated catalogue.
 *
 * No runtime, acquisition URLs, role policy, evaluation or promotion machinery.
 * Old installs have no directory-listing API: these exact ids/revisions/files
 * (including companions) let reconciliation find and remove their bytes.
 * Pins are copied unchanged from the pre-retirement modelSupply catalogue.
 */
import type { ModelDescriptor } from "./modelDescriptors";
import type { ModelArtifact } from "./modelSupply";

function companion(fileName: string, bytes: number, sha256: string): ModelArtifact {
  return Object.freeze({ fileName, bytes, sha256, url: "" });
}

function tombstone(modelId: string, revision: string, fileName: string, bytes: number, sha256: string, vision = false, extra?: ModelArtifact): ModelDescriptor {
  const format = fileName.endsWith(".gguf") ? "gguf" : "litertlm";
  return Object.freeze({
    modelId, revision, fileName, bytes, sha256, url: "",
    displayName: "Retired model", consumerTitle: "Retired model", consumerDetail: "Remove downloaded files",
    runtimeId: format === "gguf" ? "llamacpp-gguf" : vision ? "smolvlm2-litertlm" : "qwen3-litertlm-text",
    format, capabilities: Object.freeze(vision ? ["vision" as const] : ["text" as const]),
    taskRoles: Object.freeze([]), maturity: "lab", trust: "curated", tier: "advanced",
    license: modelId.startsWith("lfm") ? "LFM-1.0" : "Apache-2.0",
    minRamMb: 0, recommendedRamMb: 0, abis: Object.freeze([]), deviceQualifiedAbis: Object.freeze([]),
    downloadable: false, importable: false, cleanupOnly: true,
    distributionNote: "This model is no longer available. Remove its downloaded files in Settings.",
    ...(extra === undefined ? {} : { companions: Object.freeze([extra]) }),
  });
}

export const RETIRED_CURATED_CLEANUP: readonly ModelDescriptor[] = Object.freeze([
  tombstone("qwen3-1.7b-dynamic-int4", "79bf0667b32ae025b972e5fe555fe72ca6e8816c", "Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm", 977184032, "2a72330b504a6596d53a2c00923c57173b10f1b83e6a541213ffec08d1fc5de8"),
  tombstone("lfm2-350m-q4_0", "8fdc9d526b7ed346b19257551b05816c7912ecc2", "LFM2-350M-Q4_0.gguf", 219306944, "8e3ebc1c608dc8683adf8c3b3e6a40e2f4eab22aa33b908bff2ac03a1c16d796"),
  tombstone("lfm2-700m-q4_0", "fd39e80d7a5ac61494ffff577e61bbbfddbd0d02", "LFM2-700M-Q4_0.gguf", 446321600, "bf9c70678aff2a6ee2152b6fef4b2993892eae6449d056cf77cc1e34072424b3"),
  tombstone("lfm2-1.2b-q4_0", "5399e76c648f4eb8c053feb1ab747277dea5bf8b", "LFM2-1.2B-Q4_0.gguf", 695749568, "2cd9650c6ca71dca428cccb552b65ebc027f6c86c48e530a9d414fd67b33530b"),
  tombstone("granite-3.3-2b-instruct-q4_0", "7cdf86ccd1f1bb3491c9b7017b033f2e51367397", "granite-3.3-2b-instruct-Q4_0.gguf", 1453389088, "d5da3f5bb5a6ae442f830bdde0df4fcccb7e8bd395dc9ee5d28e704db4065592"),
  tombstone("lfm2-vl-450m-q4_0", "7cf9679aa137039135e342aa77014f7b5f2bef73", "LFM2-VL-450M-Q4_0.gguf", 219307424, "1fbf4797e8669cdeabd97fa1d31ab046907cb1fc78b1c3d4bda1ba879574e5d7", true,
    companion("mmproj-LFM2-VL-450M-Q8_0.gguf", 103890016, "a6a813fae4ba3f90852a990fdd4786a017dba0e80e599a366853ba539ee2b5ef")),
  tombstone("lfm2-vl-1.6b-q4_0", "6121de267003bb4d4f325fe10abdc735aee06747", "LFM2-VL-1.6B-Q4_0.gguf", 695750048, "ce0d4b122d328d14390ef160785da3a51a527f96844f392a04cb2db96f134e5d", true,
    companion("mmproj-LFM2-VL-1.6B-Q8_0.gguf", 564115648, "65ec437db88d65fff93f472d00c145e09880769ac67fedff5cd1c0f8d8301d87")),
  tombstone("qwen3-vl-2b-instruct-q4_k_m", "52d6c8ffea26cc873ac5ad116f8631268d7eb503", "Qwen3VL-2B-Instruct-Q4_K_M.gguf", 1107409952, "089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae", true,
    companion("mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf", 445053216, "f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82")),
  tombstone("lfm2.5-1.2b-q4_0", "8ed288026e23958ad9dfa92d53ed773a8eee7125", "LFM2.5-1.2B-Instruct-Q4_0.gguf", 695751488, "2ea801949d760cdf1a2cc04a54262c22c3c0c54f0769d57760c9adeb0e59233f"),
  tombstone("lfm2.5-vl-450m-stock", "da7396bf02715c332c21d0117d48a05851db5fb0", "LFM2.5-VL-450M_int4.litertlm", 406820224, "45a0224180c89a25299078524e5a8dfcce131686fd0f941cdcf3507095db4797", true),
  tombstone("lfm2.5-vl-450m-fixb", "da7396bf02715c332c21d0117d48a05851db5fb0", "LFM2.5-VL-450M_int4_fixB.litertlm", 406817104, "6854cd9677a34e680070b60076793e49aeb3224de7cb4101076b261cb9bf6033", true),
]);
