/**
 * Test-only adapters for op tests (not production code).
 */
import { profileFor, type ModelProfile } from "../modelProfiles";
import { FakeAiProvider } from "../testing/FakeAiProvider";
import type { GenerateFn } from "../types";

export function mustProfile(id: string): ModelProfile {
  const profile = profileFor(id);
  if (profile === undefined) throw new Error(`missing profile: ${id}`);
  return profile;
}

/** Drive an op from the deterministic fault simulator (text path). */
export function fakeGenerate(fake: FakeAiProvider): GenerateFn {
  return async (prompt, options) =>
    (
      await fake.generateText({
        prompt,
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
      })
    ).text;
}

/** Drive a vision op from the deterministic fault simulator (photo path). */
export function fakePhotoGenerate(fake: FakeAiProvider, imageUri: string): GenerateFn {
  return async (prompt, options) =>
    (
      await fake.analyzePhoto({
        imageUri,
        instruction: prompt,
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
      })
    ).text;
}

/** Canned single- or multi-shot generator (arrays serve one text per call). */
export function stubGenerate(texts: string | readonly string[]): GenerateFn & { calls: number } {
  const queue = Array.isArray(texts) ? [...texts] : [texts];
  const stub: GenerateFn & { calls: number } = Object.assign(
    async (): Promise<string> => {
      stub.calls += 1;
      if (queue.length > 1) return queue.shift() ?? "";
      return queue[0] ?? "";
    },
    { calls: 0 },
  );
  return stub;
}
