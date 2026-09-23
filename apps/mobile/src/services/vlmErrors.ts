import { isCancellation } from "./photo";

const FRIENDLY_BY_CODE: Record<string, string> = {
  GPU_UNAVAILABLE_ON_CURRENT_RUNTIME:
    "This phone's GPU can't run this model. If CPU compatibility mode is allowed, analysis may still run on CPU with an explicit on-screen notice.",
  GPU_UNAVAILABLE:
    "The model isn't available on this device right now. Open Offline AI to set it up.",
  MODEL_UNAVAILABLE:
    "The model isn't available on this device right now. Open Offline AI to set it up.",
  MODEL_MISSING:
    "Model files are missing. Open Offline AI to download or import the model again.",
  INPUT_ERROR: "The photo couldn't be read. Try a different photo.",
  UNSTRUCTURED_OUTPUT:
    "Could not read the photo — fill the details manually.",
  DOWNLOAD_FAILED: "The download failed. Open Offline AI to resume.",
  HASH_MISMATCH: "The downloaded data didn't match the expected file.",
  INSUFFICIENT_STORAGE: "Not enough free storage.",
  RUNTIME_ERROR: "The model stopped with a runtime error. Open Offline AI for details.",
  MODEL_RUNTIME_ERROR:
    "The model stopped with a runtime error. Open Offline AI for details.",
  GENERATION_ERROR: "The model ran but produced no usable output.",
};

function rawCodeOf(err: unknown): string | null {
  if (typeof err === "string" && err.length > 0) return err;
  if (err instanceof Error && err.message) return err.message;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  return null;
}

function failureOf(err: unknown): string | null {
  const failure = (err as { failure?: unknown } | null)?.failure;
  if (typeof failure === "string" && failure.length > 0) return failure;
  return null;
}

export function isVlmCancellation(err: unknown): boolean {
  if (isCancellation(err)) return true;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "CANCELLED") return true;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (message === "CANCELLED") return true;
  return /cancelled/i.test(message);
}

export function friendlyVlmMessage(err: unknown): string {
  if (err instanceof Error && err.name === "VlmUnstructuredOutputError") {
    return FRIENDLY_BY_CODE.UNSTRUCTURED_OUTPUT as string;
  }
  const candidates = [failureOf(err), rawCodeOf(err)];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (/unstructured/i.test(candidate)) {
      return FRIENDLY_BY_CODE.UNSTRUCTURED_OUTPUT as string;
    }
    const mapped = FRIENDLY_BY_CODE[candidate];
    if (mapped != null) return mapped;
    for (const code of Object.keys(FRIENDLY_BY_CODE)) {
      if (candidate.includes(code)) return FRIENDLY_BY_CODE[code] as string;
    }
    if (/not installed|files not found/i.test(candidate)) {
      return FRIENDLY_BY_CODE.MODEL_MISSING as string;
    }
    if (/model runtime is not ready/i.test(candidate)) {
      return "Model runtime is not ready. Complete accelerator verification before setting it active.";
    }
    // Human sentences (spaces, mixed case) pass through; bare future
    // codes fail closed to the generic message below.
    if (/[a-z]/.test(candidate) && /\s/.test(candidate)) {
      if (/READY_GPU|\bAUTO\b/.test(candidate)) {
        return "The model isn't available on this device right now. Open Offline AI to set it up.";
      }
      return candidate;
    }
  }
  return "Something went wrong. Open Offline AI to check the model status.";
}
