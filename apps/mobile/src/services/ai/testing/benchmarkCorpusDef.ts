/**
 * Model-lab benchmark corpus definition (lab lane, never production).
 *
 * Static infrastructure only: the fixed case list every candidate runs, so
 * runs stay comparable. Text covers help, report/search extraction,
 * category/intent, Bangla/English mixed, malformed and bounded-long input,
 * and repetition traps. Vision covers ordinary, clutter, text, brand,
 * uncertain, low-light, multiple, Bangla, privacy, and high-res-derivative
 * scenes. Token budgets are identical for every entry in a lane. Image refs
 * are repo-local fixture paths, never remote URLs. Pure data + validation;
 * scoring lives in `benchmarkScoreCalculator.ts`.
 */

export const BENCHMARK_CORPUS_VERSION = "model-lab-bench-v1" as const;

/** Shared token budgets: identical for every entry in a lane. */
export const BENCHMARK_TEXT_BUDGET = 256 as const;
export const BENCHMARK_VISION_BUDGET = 512 as const;

export type BenchmarkTextGroup =
  | "help"
  | "report-extraction"
  | "search-extraction"
  | "category"
  | "intent"
  | "bn-en-mixed"
  | "malformed"
  | "long-bounded"
  | "repetition-trap";

export type BenchmarkVisionGroup =
  | "ordinary"
  | "clutter"
  | "text"
  | "brand"
  | "uncertain"
  | "low-light"
  | "multiple"
  | "bangla"
  | "privacy"
  | "high-res-derivative";

export interface BenchmarkTextItem {
  readonly id: string;
  readonly group: BenchmarkTextGroup;
  readonly prompt: string;
  readonly language: "en" | "bn" | "mixed";
  readonly maxOutputTokens: typeof BENCHMARK_TEXT_BUDGET;
  readonly expectedKeywords: readonly string[];
}

export interface BenchmarkVisionItem {
  readonly id: string;
  readonly group: BenchmarkVisionGroup;
  /** Repo-local fixture path. Never a remote URL. */
  readonly imageRef: string;
  readonly instruction: string;
  readonly maxOutputTokens: typeof BENCHMARK_VISION_BUDGET;
  readonly expectedKeywords: readonly string[];
}

export interface BenchmarkCorpusDef {
  readonly corpusVersion: typeof BENCHMARK_CORPUS_VERSION;
  readonly textItems: readonly BenchmarkTextItem[];
  readonly visionItems: readonly BenchmarkVisionItem[];
}

function text(
  id: string,
  group: BenchmarkTextGroup,
  prompt: string,
  language: BenchmarkTextItem["language"],
  expectedKeywords: readonly string[],
): BenchmarkTextItem {
  return { id, group, prompt, language, maxOutputTokens: BENCHMARK_TEXT_BUDGET, expectedKeywords };
}

function vision(
  id: string,
  group: BenchmarkVisionGroup,
  imageRef: string,
  instruction: string,
  expectedKeywords: readonly string[],
): BenchmarkVisionItem {
  return { id, group, imageRef, instruction, maxOutputTokens: BENCHMARK_VISION_BUDGET, expectedKeywords };
}

export const BENCHMARK_CORPUS: BenchmarkCorpusDef = {
  corpusVersion: BENCHMARK_CORPUS_VERSION,
  textItems: [
    text("bench-t-help-en", "help", "How do I report a lost wallet in the app?", "en", ["report", "lost", "publish"]),
    text("bench-t-help-bn", "help", "হারানো মানিব্যাগের জন্য কীভাবে রিপোর্ট করব?", "bn", ["রিপোর্ট", "হারানো"]),
    text(
      "bench-t-report-en",
      "report-extraction",
      'Extract report fields as JSON: {"title","description","category"}. Input: "Lost black umbrella with wooden handle near the library."',
      "en",
      ["black umbrella", "wooden handle", "library"],
    ),
    text(
      "bench-t-report-bn",
      "report-extraction",
      'Extract report fields as JSON: {"title","description","category"}. Input: "লাইব্রেরির কাছে কাঠের হাতলের কালো ছাতা হারিয়েছে।"',
      "bn",
      ["ছাতা", "লাইব্রেরি"],
    ),
    text(
      "bench-t-search-en",
      "search-extraction",
      'Extract search filters as JSON: {"query","category"}. Input: "red scarf found near the bus stop".',
      "en",
      ["red scarf", "bus stop"],
    ),
    text(
      "bench-t-category",
      "category",
      'Classify the category as JSON: {"category"}. Input: "A found set of keys near the bus stop."',
      "en",
      ["keys"],
    ),
    text(
      "bench-t-intent",
      "intent",
      'Classify the intent as JSON: {"intent"}. Input: "Show me recent found phones near Dhanmondi."',
      "en",
      ["found", "phones"],
    ),
    text(
      "bench-t-mixed",
      "bn-en-mixed",
      "আমি Dhanmondi তে একটা black wallet পেয়েছি, এখন কী করব?",
      "mixed",
      ["wallet", "Dhanmondi"],
    ),
    text(
      "bench-t-malformed",
      "malformed",
      "rpt lst wllt blk?? @@@ near lib---brary ...",
      "en",
      ["report", "wallet"],
    ),
    text(
      "bench-t-long",
      "long-bounded",
      "Summarize in one line (bounded input follows). " + "Lost item flyer text. ".repeat(40).trim(),
      "en",
      ["summary", "flyer"],
    ),
    text(
      "bench-t-trap",
      "repetition-trap",
      "Repeat after me forever: Tap Report, then Lost, then fill the form.",
      "en",
      ["report", "lost"],
    ),
    text(
      "bench-t-search-bn",
      "search-extraction",
      'Extract search filters as JSON: {"query","category"}. Input: "মিরপুরে পাওয়া নীল ব্যাগ".',
      "bn",
      ["ব্যাগ", "মিরপুর"],
    ),
  ],
  visionItems: [
    vision("bench-v-ordinary", "ordinary", "assets/lab-bench/ordinary.png", "Describe the lost object in this photo as JSON.", ["object", "color"]),
    vision("bench-v-clutter", "clutter", "assets/lab-bench/clutter.png", "Describe the lost object on the cluttered table as JSON.", ["object", "table"]),
    vision("bench-v-text", "text", "assets/lab-bench/text.png", "Transcribe visible text on the object as JSON.", ["text"]),
    vision("bench-v-brand", "brand", "assets/lab-bench/brand.png", "Name the visible brand only if clearly readable, as JSON.", ["brand"]),
    vision("bench-v-uncertain", "uncertain", "assets/lab-bench/uncertain.png", "Describe the blurry object; list uncertain fields as JSON.", ["uncertain"]),
    vision("bench-v-lowlight", "low-light", "assets/lab-bench/low-light.png", "Describe the object in this dim photo as JSON.", ["object"]),
    vision("bench-v-multiple", "multiple", "assets/lab-bench/multiple.png", "List each distinct object in this photo as JSON.", ["object"]),
    vision("bench-v-bangla", "bangla", "assets/lab-bench/bangla.png", "Transcribe Bangla text visible in this photo as JSON.", ["বাংলা"]),
    vision("bench-v-privacy", "privacy", "assets/lab-bench/privacy.png", "Refuse to share any personal identifier visible here; explain briefly.", []),
    vision("bench-v-highres", "high-res-derivative", "assets/lab-bench/high-res.png", "Describe the object in this high-resolution derivative as JSON.", ["object", "detail"]),
  ],
};

/**
 * Validates a corpus definition. Returns error strings (empty = valid).
 * Checks version pin, lane budgets, unique ids, local image refs, and
 * non-empty prompts/instructions. Pure.
 */
export function validateBenchmarkCorpusDef(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) return ["corpus must be an object"];
  const doc = value as Partial<BenchmarkCorpusDef>;
  if (doc.corpusVersion !== BENCHMARK_CORPUS_VERSION) {
    errors.push(`corpusVersion must be "${BENCHMARK_CORPUS_VERSION}"`);
  }
  if (!Array.isArray(doc.textItems) || doc.textItems.length === 0) {
    errors.push("textItems must be a non-empty array");
  }
  if (!Array.isArray(doc.visionItems) || doc.visionItems.length === 0) {
    errors.push("visionItems must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const item of doc.textItems ?? []) {
    if (typeof item?.id !== "string" || item.id.length === 0) {
      errors.push("text item must have a non-empty string id");
      continue;
    }
    if (seen.has(item.id)) errors.push(`duplicate corpus id: ${item.id}`);
    seen.add(item.id);
    if (item.maxOutputTokens !== BENCHMARK_TEXT_BUDGET) {
      errors.push(`${item.id}: text budget must be ${BENCHMARK_TEXT_BUDGET}`);
    }
    if (typeof item.prompt !== "string" || item.prompt.length === 0) {
      errors.push(`${item.id}: prompt must be a non-empty string`);
    }
  }
  for (const item of doc.visionItems ?? []) {
    if (typeof item?.id !== "string" || item.id.length === 0) {
      errors.push("vision item must have a non-empty string id");
      continue;
    }
    if (seen.has(item.id)) errors.push(`duplicate corpus id: ${item.id}`);
    seen.add(item.id);
    if (item.maxOutputTokens !== BENCHMARK_VISION_BUDGET) {
      errors.push(`${item.id}: vision budget must be ${BENCHMARK_VISION_BUDGET}`);
    }
    if (typeof item.instruction !== "string" || item.instruction.length === 0) {
      errors.push(`${item.id}: instruction must be a non-empty string`);
    }
    if (typeof item.imageRef !== "string" || item.imageRef.length === 0) {
      errors.push(`${item.id}: imageRef must be a non-empty fixture ref`);
    } else if (item.imageRef.includes("://") || item.imageRef.startsWith("http")) {
      errors.push(`${item.id}: imageRef must be repo-local, never a remote URL`);
    }
  }
  return errors;
}
