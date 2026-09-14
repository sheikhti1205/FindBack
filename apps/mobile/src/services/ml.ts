import { ML_KEYWORD_TO_CATEGORY, type Category } from "@findback/shared";

export interface CategorySuggestion {
  category: Category;
  confidence: number;
  rawLabel: string;
}

/**
 * Bundled TensorFlow.js MobileNet V1 (alpha 0.25) graph model.
 *
 * The model ships inside the app (`public/models/mobilenet/`, copied verbatim
 * into the web build and the Android APK — see `apps/mobile/public/models/mobilenet/ATTRIBUTION.md`
 * and `scripts/fetch-ml-model.mjs`). Loading is strictly local: there is no
 * TensorFlow CDN fallback, so category suggestion works with no network and no
 * image ever leaves the device.
 */
export const LOCAL_MODEL_URL = "/models/mobilenet/model.json";

/** Raised when the bundled model cannot be loaded (missing/corrupt build). */
export class MlUnavailableError extends Error {
  constructor(message = "On-device category model is unavailable in this build.") {
    super(message);
    this.name = "MlUnavailableError";
  }
}

/**
 * Classify an image File entirely on-device and map the ImageNet label to a
 * FindBack category. Returns `null` when the image is recognized but maps to no
 * specific category; throws `MlUnavailableError` when the bundled model is
 * missing or unloadable. No remote model weights are ever fetched.
 */
export async function suggestCategoryFromImage(file: File): Promise<CategorySuggestion | null> {
  const [tf, mobilenet] = await Promise.all([
    import("@tensorflow/tfjs"),
    import("@tensorflow-models/mobilenet"),
  ]);

  await tf.ready();
  if (tf.getBackend() !== "webgl" && tf.getBackend() !== "cpu") {
    try {
      await tf.setBackend("webgl");
    } catch {
      await tf.setBackend("cpu");
    }
  }

  let model;
  try {
    model = await mobilenet.load({ version: 1, alpha: 0.25, modelUrl: LOCAL_MODEL_URL });
  } catch (err) {
    console.error("Bundled ML model failed to load", err);
    throw new MlUnavailableError();
  }

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const predictions = await model.classify(img, 5);

    let best: { category: Category; confidence: number; rawLabel: string } | null = null;
    for (const p of predictions) {
      const category = mapLabelToCategory(p.className);
      if (!category) continue;
      if (!best || p.probability > best.confidence) {
        best = { category, confidence: p.probability, rawLabel: p.className };
      }
    }
    if (best) return best;

    const top = predictions[0];
    if (top) {
      return { category: "Other", confidence: top.probability, rawLabel: top.className };
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Map an ImageNet class label to a FindBack category via shared keywords. */
export function mapLabelToCategory(className: string): Category | null {
  const tokens = className
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (const token of tokens) {
    const category = ML_KEYWORD_TO_CATEGORY[token];
    if (category && category !== "Other") return category;
  }
  return null;
}
