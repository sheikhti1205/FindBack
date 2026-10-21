import { expect, it } from "vitest";
import { COMMENT_REPORTS_ENABLED } from "./commentAttachments";

// §13.7: enabling needs a separate reviewed flip naming fresh hosted readback.
// No such release evidence is approved yet. Updating only this assertion is not a release.
it("pins report selection OFF until a separately reviewed capability release", () => {
  expect(COMMENT_REPORTS_ENABLED).toBe(false);
});
