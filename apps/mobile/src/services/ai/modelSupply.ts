import type { ModelDescriptor } from "./modelDescriptors";
import { safeSourceUrl } from "./download/sourcePolicy";

export type ArtifactMirrors = Readonly<Record<string, string>>;

export interface ModelArtifact {
  readonly fileName: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly url: string;
  readonly sources?: readonly string[];
}
export interface LicenseFacts {
  readonly redistribution: "permitted-with-conditions";
  readonly localImport: "permitted-with-conditions";
  readonly commercial: "permitted" | "conditional";
  readonly threshold?: string;
  readonly notice: string;
}
export const LFM_LICENSE_FACTS: LicenseFacts = {
  redistribution: "permitted-with-conditions", localImport: "permitted-with-conditions", commercial: "conditional",
  threshold: "LFM Open License v1.0 §5: not exceeding / exceeds the US$10M annual-revenue Threshold for You / Your Legal Entity. Review at or above US$10M; affiliate revenue and indirect commercial use count.",
  notice: "Give recipients the exact license; retain attribution and applicable NOTICE; mark modifications. Local import is not a commercial-use exemption.",
};
const apache: LicenseFacts = { redistribution: "permitted-with-conditions", localImport: "permitted-with-conditions", commercial: "permitted", notice: "Apache-2.0 §4: retain license, attribution and applicable NOTICE; mark modifications." };

function artifact(repo: string, revision: string, fileName: string, bytes: number, sha256: string): ModelArtifact {
  const url = `https://huggingface.co/${repo}/resolve/${revision}/${fileName}`;
  return { fileName, bytes, sha256, url, sources: [url, `${url}?download=true`, url.replace("huggingface.co", "hf.co")] };
}
function candidate(id: string, name: string, repo: string, revision: string, fileName: string, bytes: number, sha: string, ram: number, vision = false, projector?: ModelArtifact): ModelDescriptor {
  const lfm = repo.includes("LFM");
  return {
    modelId: id, displayName: name, consumerTitle: name, consumerDetail: "Evaluation only · not used automatically",
    runtimeId: fileName.endsWith("gguf") ? "llamacpp-gguf" : vision ? "smolvlm2-litertlm" : "qwen3-litertlm-text",
    format: fileName.endsWith("gguf") ? "gguf" : "litertlm", revision,
    ...artifact(repo, revision, fileName, bytes, sha),
    capabilities: vision ? ["text", "vision"] : ["text"], taskRoles: [], maturity: "lab", trust: "curated", tier: "advanced",
    license: lfm ? "LFM-1.0" : "Apache-2.0", licenseFacts: lfm ? LFM_LICENSE_FACTS : apache,
    minRamMb: ram, recommendedRamMb: ram + 1024, abis: ["arm64-v8a"], deviceQualifiedAbis: [], downloadable: true, importable: true,
    upstreamRepo: repo, ...(projector ? { companions: [projector] } : {}),
    distributionNote: lfm ? "LFM Open License v1.0 permits redistribution and local use subject to its conditions, including commercial eligibility. Fresh engine per evaluation; no product-role qualification." : "Unqualified evaluation candidate. Runtime ABI support is not device/task qualification.",
    ...(id === "qwen3-1.7b-dynamic-int4" ? { minRuntimeVersion: "0.18.0" } : {}),
  };
}
/** Immutable upstream evidence: docs/evidence/2026-10-14-model-upstream-research.md §2/3. */
export const SUPPLY_CANDIDATES: readonly ModelDescriptor[] = [
  candidate("qwen3-1.7b-dynamic-int4", "Qwen3 1.7B", "litert-community/Qwen3-1.7B", "79bf0667b32ae025b972e5fe555fe72ca6e8816c", "Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm", 977184032, "2a72330b504a6596d53a2c00923c57173b10f1b83e6a541213ffec08d1fc5de8", 2200),
  candidate("lfm2-350m-q4_0", "LFM2 350M", "LiquidAI/LFM2-350M-GGUF", "8fdc9d526b7ed346b19257551b05816c7912ecc2", "LFM2-350M-Q4_0.gguf", 219306944, "8e3ebc1c608dc8683adf8c3b3e6a40e2f4eab22aa33b908bff2ac03a1c16d796", 1200),
  candidate("lfm2-700m-q4_0", "LFM2 700M", "LiquidAI/LFM2-700M-GGUF", "fd39e80d7a5ac61494ffff577e61bbbfddbd0d02", "LFM2-700M-Q4_0.gguf", 446321600, "bf9c70678aff2a6ee2152b6fef4b2993892eae6449d056cf77cc1e34072424b3", 1500),
  candidate("lfm2-1.2b-q4_0", "LFM2 1.2B", "LiquidAI/LFM2-1.2B-GGUF", "5399e76c648f4eb8c053feb1ab747277dea5bf8b", "LFM2-1.2B-Q4_0.gguf", 695749568, "2cd9650c6ca71dca428cccb552b65ebc027f6c86c48e530a9d414fd67b33530b", 1800),
  candidate("granite-3.3-2b-instruct-q4_0", "Granite 3.3 2B Instruct", "ibm-granite/granite-3.3-2b-instruct-GGUF", "7cdf86ccd1f1bb3491c9b7017b033f2e51367397", "granite-3.3-2b-instruct-Q4_0.gguf", 1453389088, "d5da3f5bb5a6ae442f830bdde0df4fcccb7e8bd395dc9ee5d28e704db4065592", 2300),
  candidate("lfm2-vl-450m-q4_0", "LFM2-VL 450M (official GGUF)", "LiquidAI/LFM2-VL-450M-GGUF", "7cf9679aa137039135e342aa77014f7b5f2bef73", "LFM2-VL-450M-Q4_0.gguf", 219307424, "1fbf4797e8669cdeabd97fa1d31ab046907cb1fc78b1c3d4bda1ba879574e5d7", 1600, true,
    artifact("LiquidAI/LFM2-VL-450M-GGUF", "7cf9679aa137039135e342aa77014f7b5f2bef73", "mmproj-LFM2-VL-450M-Q8_0.gguf", 103890016, "a6a813fae4ba3f90852a990fdd4786a017dba0e80e599a366853ba539ee2b5ef")),
  candidate("lfm2-vl-1.6b-q4_0", "LFM2-VL 1.6B (official GGUF)", "LiquidAI/LFM2-VL-1.6B-GGUF", "6121de267003bb4d4f325fe10abdc735aee06747", "LFM2-VL-1.6B-Q4_0.gguf", 695750048, "ce0d4b122d328d14390ef160785da3a51a527f96844f392a04cb2db96f134e5d", 2400, true,
    artifact("LiquidAI/LFM2-VL-1.6B-GGUF", "6121de267003bb4d4f325fe10abdc735aee06747", "mmproj-LFM2-VL-1.6B-Q8_0.gguf", 564115648, "65ec437db88d65fff93f472d00c145e09880769ac67fedff5cd1c0f8d8301d87")),
  candidate("qwen3-vl-2b-instruct-q4_k_m", "Qwen3-VL 2B Instruct (official GGUF)", "Qwen/Qwen3-VL-2B-Instruct-GGUF", "52d6c8ffea26cc873ac5ad116f8631268d7eb503", "Qwen3VL-2B-Instruct-Q4_K_M.gguf", 1107409952, "089d75c52f4b7ffc56ba998ffc50aae89fcafc755f9e7208aacca281dca6c2ae", 2400, true,
    artifact("Qwen/Qwen3-VL-2B-Instruct-GGUF", "52d6c8ffea26cc873ac5ad116f8631268d7eb503", "mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf", 445053216, "f9a68fabba69c3b81e153367b2c7521030b0fa8bb0de400c9599c8e6725f9c82")),
  candidate("lfm2.5-1.2b-q4_0", "LFM2.5 1.2B Instruct", "LiquidAI/LFM2.5-1.2B-Instruct-GGUF", "8ed288026e23958ad9dfa92d53ed773a8eee7125", "LFM2.5-1.2B-Instruct-Q4_0.gguf", 695751488, "2ea801949d760cdf1a2cc04a54262c22c3c0c54f0769d57760c9adeb0e59233f", 1800),
  candidate("lfm2.5-vl-450m-stock", "LFM2.5-VL 450M stock (community LiteRT)", "litert-community/LFM2.5-VL-450M", "da7396bf02715c332c21d0117d48a05851db5fb0", "LFM2.5-VL-450M_int4.litertlm", 406820224, "45a0224180c89a25299078524e5a8dfcce131686fd0f941cdcf3507095db4797", 1600, true),
  candidate("lfm2.5-vl-450m-fixb", "LFM2.5-VL 450M fixB (community LiteRT)", "litert-community/LFM2.5-VL-450M", "da7396bf02715c332c21d0117d48a05851db5fb0", "LFM2.5-VL-450M_int4_fixB.litertlm", 406817104, "6854cd9677a34e680070b60076793e49aeb3224de7cb4101076b261cb9bf6033", 1600, true),
];

export function acquisitionArtifacts(d: ModelDescriptor): readonly ModelArtifact[] { return [d, ...(d.companions ?? [])]; }
export function acquisitionBytes(d: ModelDescriptor): number { return acquisitionArtifacts(d).reduce((n, f) => n + f.bytes, 0); }

export function validateArtifactMirrors(d: ModelDescriptor, mirrors: ArtifactMirrors): void {
  const files = new Set(acquisitionArtifacts(d).map((file) => file.fileName));
  for (const [fileName, url] of Object.entries(mirrors)) {
    if (!files.has(fileName) || !safeSourceUrl(url)) throw new Error("Mirror configuration needs a known artifact and a public credential-free HTTPS URL.");
  }
}

export function sourcesFor(d: ModelArtifact, mirror?: string): readonly string[] {
  const defaults = d.sources ?? (d.url.startsWith("https://huggingface.co/") ? [d.url, d.url + "?download=true", d.url.replace("huggingface.co", "hf.co")] : [d.url]);
  return mirror ? [...new Set([mirror, ...defaults])].slice(0, 4) : defaults;
}
