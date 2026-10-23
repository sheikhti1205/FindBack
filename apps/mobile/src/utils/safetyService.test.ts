import { describe, expect, it } from "vitest";
import { isMissingServerFunction } from "./safetyService";
import { ApiError } from "../services/session";

describe("has the server got that function yet?", () => {
  it("recognises every shape of the missing-function refusal", () => {
    expect(isMissingServerFunction(new ApiError("Could not find the function", 500, "PGRST202"))).toBe(true);
    expect(isMissingServerFunction(new ApiError("function does not exist", 500, "42883"))).toBe(true);
    expect(isMissingServerFunction(new ApiError("relation does not exist", 500, "42P01"))).toBe(true);
    expect(isMissingServerFunction(new ApiError("not available", 501, "RPC_UNAVAILABLE"))).toBe(true);
  });

  it("does not dress any other failure up as a missing feature", () => {
    expect(isMissingServerFunction(new ApiError("no permission", 403, "42501"))).toBe(false);
    expect(isMissingServerFunction(new ApiError("boom", 500, "UNEXPECTED_SHAPE"))).toBe(false);
    expect(isMissingServerFunction(new Error("network down"))).toBe(false);
    expect(isMissingServerFunction(null)).toBe(false);
    expect(isMissingServerFunction(undefined)).toBe(false);
  });
});
