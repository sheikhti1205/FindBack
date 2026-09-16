import { getVlmBridge } from "./vlmPlugin";

/**
 * Creates the embedding input string by trimming and joining title and description.
 * Title and description are joined with a newline if both are present.
 */
export function embeddingInput(title: string, description: string): string {
  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();

  if (trimmedTitle && trimmedDescription) {
    return `${trimmedTitle}\n${trimmedDescription}`;
  }
  return trimmedTitle || trimmedDescription;
}

/**
 * Embeds a list of texts using the native VLM bridge.
 * Returns raw vectors (number[][]) from the native implementation.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const bridge = getVlmBridge();
  return bridge.embedTexts(texts);
}