import { describe, expect, it } from "vitest";
import { groundObjects } from "./groundObjects";
import { getTaskSpec } from "../orchestrator/taskRegistry";
import { mustProfile, stubGenerate } from "./testSupport";

const VISION = "smolvlm2-500M-vision";
const CONSENT = { imageConsent: true as const };

function groundPayload(boxes: readonly unknown[], coordinateSpace = "relative-0-1000"): string {
  return JSON.stringify({ coordinateSpace, boxes });
}

const INPUT = { imageUri: "backpack.jpg", referringExpression: "the red backpack" };

describe("ground-objects op", () => {
  it("distinguishes an inference failure from user cancellation", async () => {
    const result = await groundObjects(async () => { throw new Error("runtime failed"); }, INPUT, mustProfile(VISION), CONSENT);
    expect(result).toEqual({ ok: false, error: { errorClass: "RUNTIME_ERROR", diagnostic: "GROUND_GENERATION_FAILED" } });
  });
  it("passes the actual image and abort signal to the vision transport, rather than discarding imageUri", async () => {
    const signal = new AbortController().signal;
    let seen: unknown;
    await groundObjects(async (_prompt, options) => { seen = options; return groundPayload([]); }, INPUT, mustProfile(VISION), { ...CONSENT, signal });
    expect(seen).toMatchObject({ imageUri: INPUT.imageUri, signal });
  });
  it("grounds a referring expression to boxes", async () => {
    const result = await groundObjects(
      stubGenerate(groundPayload([{ x: 10, y: 20, w: 300, h: 200, label: "red backpack" }])),
      INPUT,
      mustProfile(VISION),
      CONSENT,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        coordinateSpace: "relative-0-1000",
        boxes: [{ x: 10, y: 20, w: 300, h: 200, label: "red backpack" }],
      },
    });
  });

  it("accepts an empty match set", async () => {
    const result = await groundObjects(stubGenerate(groundPayload([])), INPUT, mustProfile(VISION), CONSENT);
    expect(result).toEqual({ ok: true, value: { coordinateSpace: "relative-0-1000", boxes: [] } });
  });

  it("rejects malformed boxes (invalid shape)", async () => {
    const notArray = await groundObjects(
      stubGenerate(groundPayload("nope" as unknown as never)),
      INPUT,
      mustProfile(VISION),
      CONSENT,
    );
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) expect(notArray.error.diagnostic).toBe("R1_BAD_FIELD:boxes");

    const missingCoord = await groundObjects(
      stubGenerate(groundPayload([{ x: 10, y: 20, w: 300, label: "red backpack" }])),
      INPUT,
      mustProfile(VISION),
      CONSENT,
    );
    expect(missingCoord.ok).toBe(false);
    if (!missingCoord.ok) expect(missingCoord.error.diagnostic).toBe("R1_BAD_FIELD:box-coords");
  });

  it("rejects coordinate spaces outside the allowlist (invalid enum)", async () => {
    const result = await groundObjects(
      stubGenerate(groundPayload([{ x: 10, y: 20, w: 300, h: 200, label: "red backpack" }], "pixels")),
      INPUT,
      mustProfile(VISION),
      CONSENT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorClass).toBe("INVALID_OUTPUT");
      expect(result.error.diagnostic).toBe("R1_UNKNOWN_COORDINATE_SPACE:pixels");
    }
  });

  it("rejects oversize box sets", async () => {
    const boxes = Array.from({ length: 9 }, (_, i) => ({ x: i, y: i, w: 10, h: 10, label: `box ${i}` }));
    const result = await groundObjects(stubGenerate(groundPayload(boxes)), INPUT, mustProfile(VISION), CONSENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toBe("R5_TOO_MANY_BOXES");
  });

  it("rejects out-of-bounds boxes (business rule)", async () => {
    const result = await groundObjects(
      stubGenerate(groundPayload([{ x: 900, y: 900, w: 200, h: 200, label: "red backpack" }])),
      INPUT,
      mustProfile(VISION),
      CONSENT,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.diagnostic).toBe("R1_BUSINESS_RULE:BOX_OUT_OF_BOUNDS");
  });

  it("refuses without image consent and never calls generate", async () => {
    const generate = stubGenerate(groundPayload([{ x: 10, y: 20, w: 300, h: 200, label: "red backpack" }]));
    const result = await groundObjects(generate, INPUT, mustProfile(VISION));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorClass).toBe("UNSUPPORTED_REQUEST");
      expect(result.error.diagnostic).toBe("CONSENT_REQUIRED:image");
    }
    expect(generate.calls).toBe(0);
  });

  it("surfaces cancellation without calling generate", async () => {
    const generate = stubGenerate(groundPayload([]));
    const controller = new AbortController();
    controller.abort();
    const result = await groundObjects(generate, INPUT, mustProfile(VISION), {
      ...CONSENT,
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, error: { errorClass: "CANCELLED", diagnostic: "ABORT_BEFORE_START" } });
    expect(generate.calls).toBe(0);
  });

  it("carries the canonical vision envelope; image consent is enforced by the op, not the route", () => {
    const spec = getTaskSpec("ground-objects")!;
    expect(spec.taskId).toBe("ground-objects");
    expect(spec.maxInputChars).toBe(140);
    // Enforced route budget wins over the retired table's advisory 60s.
    expect(spec.timeoutMs).toBe(30_000);
    expect(spec.privacy.tier).toBe("local-only");
    expect(spec.privacy.handlesImage).toBe(true);
    expect(spec.runtimes).toEqual(["local-vision"]);
    expect(spec.consent.required).toBe(false);
    expect(spec.consent.kind).toBe("image");
  });
});
