/**
 * W-A lane: LiteRT-LM general text seam (Qwen3 0.6B production resident).
 *
 * The TypeScript side owns the bridge SHAPE, thought-envelope stripping,
 * the session token floor, and fail-closed absence — the native
 * `FindbackQwenText` plugin itself is the W-B lane. These tests pin the
 * contract W-B builds against, using fakes. No network, no binaries.
 */
import { describe, expect, it } from "vitest";
import {
  QWEN_SESSION_MIN_TOKENS,
  QWEN_TEXT_BRIDGE_NAME,
  QWEN_TEXT_PLUGIN_NAME,
  createEnvelopeStreamingFilter,
  isQwenTextAvailable,
  stripThoughtEnvelope,
} from "./litertLmText";
import { profileFor } from "../modelProfiles";
import { QWEN_TEXT_MODEL_ID } from "../modelDescriptors";

describe("litertLmText seam", () => {
  it("names the native plugin and bridge W-B binds", () => {
    expect(QWEN_TEXT_PLUGIN_NAME).toBe("FindbackQwenText");
    expect(QWEN_TEXT_BRIDGE_NAME).toBe("qwen3-litertlm-text");
  });

  it("strips the profile's thought envelope before user output, never leaking reasoning", () => {
    const envelope = profileFor(QWEN_TEXT_MODEL_ID)?.thoughtEnvelope;
    expect(envelope).toEqual({ openMarker: "[thought]", closeMarker: "[/thought]" });
    expect(stripThoughtEnvelope("[thought]planning the answer[/thought]A red umbrella.", envelope)).toBe(
      "A red umbrella.",
    );
    expect(
      stripThoughtEnvelope("Prefix [thought]hidden[/thought] middle [thought]more[/thought] suffix", envelope),
    ).toBe("Prefix  middle  suffix");
    // Unclosed envelopes fail closed: no partial reasoning reaches the user.
    expect(stripThoughtEnvelope("[thought]only reasoning, no answer", envelope)).toBe("");
    expect(stripThoughtEnvelope("Plain answer without envelopes.", envelope)).toBe(
      "Plain answer without envelopes.",
    );
    expect(stripThoughtEnvelope("  [thought]x[/thought]   ", envelope).trim()).toBe("");
  });

  it("requires the 1024-token session floor the lab profile measured for Qwen", () => {
    expect(QWEN_SESSION_MIN_TOKENS).toBe(1024);
  });

  it("streams envelope stripping chunk-by-chunk without leaking partial markers", () => {
    const envelope = profileFor(QWEN_TEXT_MODEL_ID)?.thoughtEnvelope;
    // Envelope split across chunk boundaries: the concatenated emissions
    // equal the one-shot strip, plain text streams promptly (no
    // buffered-then-burst fake streaming), and no single emission carries
    // envelope markers or inside-envelope reasoning.
    const filter = createEnvelopeStreamingFilter(envelope);
    const chunks = ["Hello [tho", "ught]secret reas", "oning[/th", "ought] world"];
    const emissions = chunks.map((chunk) => filter.push(chunk));
    emissions.push(filter.flush());
    for (const emission of emissions) {
      expect(emission).not.toContain("[thought]");
      expect(emission).not.toContain("[/thought]");
      expect(emission).not.toContain("secret");
    }
    expect(emissions.join("")).toBe(
      stripThoughtEnvelope("Hello [thought]secret reasoning[/thought] world", envelope),
    );
    expect(emissions.join("")).toBe("Hello  world");
    // Unclosed envelope at flush: dropped, never leaked.
    const leaking = createEnvelopeStreamingFilter(envelope);
    const leaked = leaking.push("Answer [thought]oops, no close") + leaking.flush();
    expect(leaked).toBe("Answer ");
  });

  it("reports unavailable when no native bridge is injected (web / missing plugin)", async () => {
    await expect(isQwenTextAvailable(undefined)).resolves.toBe(false);
    await expect(
      isQwenTextAvailable({ isTextAvailable: async () => true } as never),
    ).resolves.toBe(true);
    await expect(
      isQwenTextAvailable({
        isTextAvailable: async () => {
          throw new Error("no plugin");
        },
      } as never),
    ).resolves.toBe(false);
  });
});
