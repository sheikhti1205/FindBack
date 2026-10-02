/**
 * llama.cpp challenger adapter stub (WS4, isolated scope).
 *
 * Benchmark-only challenger for GGUF arms (LFM2.5-1.2B-Q4_0 and future
 * permissive GGUF entries). This stub owns NO runtime binding: `load()`
 * enforces the LFM license gate BEFORE touching any native module, and the
 * actual llama.cpp session wiring is an explicit TODO for the runtime owner.
 *
 * Invariants:
 * - License check runs before any native load attempt (fail-closed).
 * - A blocked license throws LfmLicenseBlockedError; the native runtime is
 *   never referenced on that path.
 * - Does not register with the orchestrator, router, Needle, probe, UI,
 *   bench, or packer — challenger harness wires it explicitly for benchmarks.
 */
import type { ModelProfile } from "../modelProfiles";
import { enforce, type DistributionChannel } from "./licenseGate";

/** Runtime id this challenger targets. GGUF profiles only. */
export const LLAMA_CPP_RUNTIME = "llama-cpp" as const;

/** Thrown when the license gate blocks a load before any native call. */
export class LfmLicenseBlockedError extends Error {
  readonly profileId: string;
  readonly channel: DistributionChannel;

  constructor(profileId: string, channel: DistributionChannel, reason: string) {
    super(`license gate blocked load: ${profileId} (${channel}): ${reason}`);
    this.name = "LfmLicenseBlockedError";
    this.profileId = profileId;
    this.channel = channel;
  }
}

export interface LlamaLoadRequest {
  readonly channel: DistributionChannel;
}

export interface LlamaSessionStub {
  readonly profileId: string;
  readonly runtime: typeof LLAMA_CPP_RUNTIME;
  readonly channel: DistributionChannel;
  /** Stub dispose — no native handle exists yet. */
  dispose(): void;
}

/**
 * Benchmark-only llama.cpp challenger stub.
 *
 * `load()` first runs `licenseGate.enforce(profile, channel)`; only an
 * allowed decision proceeds to the (not yet implemented) native session
 * creation, which currently throws a not-implemented error so the stub can
 * never silently stand in for a real runtime.
 */
export class LlamaCppChallenger {
  async load(profile: ModelProfile, request: LlamaLoadRequest): Promise<LlamaSessionStub> {
    const decision = enforce(profile, request.channel);
    if (!decision.allowed) {
      throw new LfmLicenseBlockedError(profile.id, request.channel, decision.reason);
    }
    if (profile.runtime !== LLAMA_CPP_RUNTIME) {
      throw new Error(
        `llama.cpp challenger cannot load ${profile.id}: runtime is ${profile.runtime}, expected ${LLAMA_CPP_RUNTIME}`,
      );
    }
    // TODO(runtime-owner): create the real llama.cpp session here (GGUF +
    // mmproj path). This stub intentionally stops after the license gate so
    // no caller can mistake it for a working inference backend.
    throw new Error(
      `llama.cpp session for ${profile.id} is not implemented (challenger stub; license gate passed for ${request.channel})`,
    );
  }

  /** License pre-check without attempting any load. */
  checkLicense(profile: ModelProfile, channel: DistributionChannel) {
    return enforce(profile, channel);
  }
}
