import { ML_KEYWORD_TO_CATEGORY, type Category } from "@findback/shared";

export interface CategorySuggestion {
  category: Category;
  confidence: number;
  rawLabel: string;
}

/**
 * On-device image classification (TensorFlow.js + MobileNet, Apache-2.0).
 *
 * The generic ImageNet labels are mapped transparently through the shared
 * ML_KEYWORD_TO_CATEGORY table into FindBack categories. Loading is lazy so the
 * ~few-hundred-KB TensorFlow runtime is only fetched when the user taps
 * "Suggest category". Model weights are served locally when the bundled model
 * exists (public/models/mobilenet — see scripts/fetch-ml-model.mjs) and
 * otherwise load from the TensorFlow CDN, still running inference on-device.
 */
export async function suggestCategoryFromImage(file: File): Promise<CategorySuggestion | null> {
  try {
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

    const modelUrl = await bundledModelUrl();
    const model = await mobilenet.load({ version: 1, alpha: 0.25, modelUrl });

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
  } catch (err) {
    console.error("ML classification failed", err);
    return null;
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

async function bundledModelUrl(): Promise<string | undefined> {
  try {
    const res = await fetch("/models/mobilenet/model.json", { method: "HEAD" });
    if (res.ok) return "/models/mobilenet/model.json";
  } catch {
    /* offline or missing */
  }
  return undefined;
}
