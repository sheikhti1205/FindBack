/**
 * Preflight context budget as a pure function of verified capability metadata
 * (packet R1, Context & Memory Contract §3–4).
 *
 * `usableInput = verifiedContextWindow - reservedOutput - imageAllowance
 *   - protocolOverhead - safetyMargin`, with every term explicit. Unknown
 * stays unknown: any missing term yields an `unknown` budget, never a zero.
 * File bytes are transport size, never image tokens. The output cap is a
 * separate reservation, not a slice of the window. Compaction is triggered
 * by a 60–70% fraction of the verified effective window — an illustration
 * for a 200k window is not a constant baked into smaller routes.
 */
export const COMPACTION_TRIGGER_LOW = 0.6;
export const COMPACTION_TRIGGER_HIGH = 0.7;

/** Legacy output reservation preserved when no verified cap is known. */
export const DEFAULT_OUTPUT_CAP_TOKENS = 600;

export type ContextBudgetInput = {
  /** Verified effective window for the selected model/route. Unknown when absent. */
  readonly verifiedContextWindow?: number;
  readonly reservedOutput?: number;
  /** Total image-token allowance for this send (count × per-image estimate). */
  readonly imageAllowance?: number;
  readonly protocolOverhead?: number;
  readonly safetyMargin?: number;
  /** Measured or conservative prompt estimate for this send. */
  readonly estimatedInput?: number;
  /** Approved image reference count (never bytes). */
  readonly imageCount?: number;
  /**
   * Transport file size in bytes. Accepted for call-site convenience and
   * explicitly ignored by the token math: bytes are not image tokens.
   */
  readonly fileBytes?: number;
};

export type ContextBudget = {
  readonly state: "known" | "unknown";
  readonly unknownReasons: readonly string[];
  readonly input: ContextBudgetInput;
  readonly effectiveWindow?: number;
  readonly usableInput?: number;
  /** Fraction-based trigger: 60% of the verified usable input. */
  readonly compactionThreshold?: number;
  readonly estimatedInput?: number;
  readonly fitsInput?: boolean;
  readonly shouldCompact: boolean;
  readonly imageCount?: number;
};

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function knownPositive(value: number | undefined, name: string, reasons: string[]): number | undefined {
  if (value === undefined) {
    reasons.push(name);
    return undefined;
  }
  const parsed = positiveInt(value);
  if (parsed === undefined) {
    reasons.push(name);
    return undefined;
  }
  return parsed;
}

export function computeContextBudget(input: ContextBudgetInput): ContextBudget {
  const reasons: string[] = [];
  const window = knownPositive(input.verifiedContextWindow, "verifiedContextWindow", reasons);
  // A zero window is not a window: keep it unknown rather than budgeting zero.
  if (window === 0) reasons.push("verifiedContextWindow");
  const reservedOutput = knownPositive(input.reservedOutput, "reservedOutput", reasons);
  const imageAllowance = knownPositive(input.imageAllowance, "imageAllowance", reasons);
  const protocolOverhead = knownPositive(input.protocolOverhead, "protocolOverhead", reasons);
  const safetyMargin = knownPositive(input.safetyMargin, "safetyMargin", reasons);
  const estimated = input.estimatedInput === undefined ? undefined : positiveInt(input.estimatedInput);
  const imageCount = input.imageCount === undefined ? undefined : positiveInt(input.imageCount);

  if (
    window === undefined ||
    window === 0 ||
    reservedOutput === undefined ||
    imageAllowance === undefined ||
    protocolOverhead === undefined ||
    safetyMargin === undefined
  ) {
    return {
      state: "unknown",
      unknownReasons: reasons,
      input,
      ...(estimated === undefined ? {} : { estimatedInput: estimated }),
      ...(imageCount === undefined ? {} : { imageCount }),
      shouldCompact: false,
    };
  }

  const usableInput = window - reservedOutput - imageAllowance - protocolOverhead - safetyMargin;
  const compactionThreshold = COMPACTION_TRIGGER_LOW * usableInput;
  const fitsInput = estimated === undefined ? undefined : estimated <= usableInput;
  return {
    state: "known",
    unknownReasons: [],
    input,
    effectiveWindow: window,
    usableInput,
    compactionThreshold,
    ...(estimated === undefined ? {} : { estimatedInput: estimated }),
    ...(fitsInput === undefined ? {} : { fitsInput }),
    shouldCompact: estimated === undefined ? false : estimated >= compactionThreshold,
    ...(imageCount === undefined ? {} : { imageCount }),
  };
}

/**
 * Rebudget before sending when the model or route changes (for example a
 * 200k route falling back to 32k). The previous estimate is re-evaluated
 * against the new verified window; an unverified window stays unknown.
 */
export function replanForModelSwitch(
  input: ContextBudgetInput,
  nextWindow: number | undefined,
): ContextBudget {
  return computeContextBudget({ ...input, verifiedContextWindow: nextWindow });
}

export type ImageAllowanceInput = {
  readonly imageCount: number;
  /** Per-image token estimate from verified capability metadata. */
  readonly tokensPerImage?: number;
};

/**
 * Derive the total image-token allowance from count × per-image estimate.
 * Unknown per-image cost stays unknown; byte sizes never enter this path.
 */
export function estimateImageAllowance(input: ImageAllowanceInput): number | undefined {
  const count = positiveInt(input.imageCount);
  if (count === undefined) return undefined;
  if (input.tokensPerImage === undefined) return undefined;
  const perImage = positiveInt(input.tokensPerImage);
  if (perImage === undefined) return undefined;
  return count * perImage;
}

/**
 * Resolve the output cap separately from the context window. An unknown or
 * invalid cap falls back to the legacy reservation; callers that learn a
 * verified cap pass it explicitly.
 */
export function resolveOutputCap(
  input: { readonly maxOutputTokens?: number },
  fallback: number = DEFAULT_OUTPUT_CAP_TOKENS,
): number {
  const cap = positiveInt(input.maxOutputTokens);
  if (cap === undefined || cap === 0) return fallback;
  return cap;
}
