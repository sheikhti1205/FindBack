import { describe, expect, it } from "vitest";
import {
  CAPABILITIES_VERSION,
  MEASURED_FLAGS_NONE,
  getAutoCapabilityCopy,
  getGpuCapabilityCopy,
  getNeedleCapabilityCopy,
  getOfflineCapabilityCopy,
} from "./appCapabilities";

const ALL_EVIDENCE = {
  hasFreshAutoProbe: true,
  hasVerifiedOfflineModel: true,
  hasNeedleEvidence: true,
  hasFreshGpuProbe: true,
};

/** Premature superlatives the gated copy must never utter. */
const PREMATURE_CLAIMS: Array<[RegExp, string]> = [
  [/faster/i, "faster"],
  [/auto-magic|automagic/i, "auto-magic"],
  [/instant/i, "instant"],
  [/always best/i, "always-best"],
  [/no measurement needed/i, "measurement-free"],
];

describe("measured-state-gated capability copy", () => {
  it("versions the application integration facts", () => {
    expect(CAPABILITIES_VERSION).toBe("1.9.3-beta-truth");
  });

  it("defaults every gate to no-evidence", () => {
    expect(MEASURED_FLAGS_NONE).toEqual({
      hasFreshAutoProbe: false,
      hasVerifiedOfflineModel: false,
      hasNeedleEvidence: false,
      hasFreshGpuProbe: false,
    });
  });

  it("hides every affordance without evidence", () => {
    expect(getAutoCapabilityCopy(MEASURED_FLAGS_NONE).join(" ")).toMatch(
      /hidden/i,
    );
    expect(getOfflineCapabilityCopy(MEASURED_FLAGS_NONE).join(" ")).toMatch(
      /hidden/i,
    );
    expect(getNeedleCapabilityCopy(MEASURED_FLAGS_NONE).join(" ")).toMatch(
      /hidden/i,
    );
    expect(getGpuCapabilityCopy(MEASURED_FLAGS_NONE).join(" ")).toMatch(
      /hidden/i,
    );
  });

  it("shows measured copy only behind explicit flags", () => {
    expect(getAutoCapabilityCopy(ALL_EVIDENCE).join(" ")).toMatch(
      /measured/i,
    );
    expect(getOfflineCapabilityCopy(ALL_EVIDENCE).join(" ")).toMatch(
      /verified/i,
    );
    expect(getNeedleCapabilityCopy(ALL_EVIDENCE).join(" ")).toMatch(
      /measurement/i,
    );
    expect(getGpuCapabilityCopy(ALL_EVIDENCE).join(" ")).toMatch(
      /measured/i,
    );
    // Each flag gates only its own affordance.
    expect(
      getGpuCapabilityCopy({
        ...MEASURED_FLAGS_NONE,
        hasFreshAutoProbe: true,
      }).join(" "),
    ).toMatch(/hidden/i);
  });

  it("never claims GPU-faster or auto-magic behavior", () => {
    const copies = [
      getAutoCapabilityCopy(ALL_EVIDENCE).join(" "),
      getOfflineCapabilityCopy(ALL_EVIDENCE).join(" "),
      getNeedleCapabilityCopy(ALL_EVIDENCE).join(" "),
      getGpuCapabilityCopy(ALL_EVIDENCE).join(" "),
      getAutoCapabilityCopy(MEASURED_FLAGS_NONE).join(" "),
      getOfflineCapabilityCopy(MEASURED_FLAGS_NONE).join(" "),
      getNeedleCapabilityCopy(MEASURED_FLAGS_NONE).join(" "),
      getGpuCapabilityCopy(MEASURED_FLAGS_NONE).join(" "),
    ];
    for (const copy of copies) {
      for (const [pattern, label] of PREMATURE_CLAIMS) {
        expect(pattern.test(copy), `gated copy claims ${label}`).toBe(false);
      }
    }
  });
});
