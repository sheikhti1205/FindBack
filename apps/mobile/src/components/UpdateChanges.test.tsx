// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { UpdateChanges } from "./UpdateChanges";
import type { FeatureAnnouncement, FeatureContext } from "../services/updates/types";

afterEach(cleanup);
const feature: FeatureAnnouncement = { id: "test", releaseId: "test-release", summary: "Clearer local search tools.", destinationId: "local-intelligence", platforms: ["android"], acceptedBuildShas: ["a".repeat(40)], acceptanceReceipt: "synthetic-receipt", prerequisites: [] };
const context: FeatureContext = { platform: "android", buildGitSha: "a".repeat(40), signedIn: true, capabilities: [], satisfiedPrerequisites: [] };
describe("availability-aware update changes", () => {
  it("links a capability only for its accepted build and canonical destination", () => {
    render(<MemoryRouter><UpdateChanges features={[feature]} context={context} /></MemoryRouter>);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/settings/local-intelligence");
  });
  it("keeps unavailable changes informational without a false Try action", () => {
    render(<MemoryRouter><UpdateChanges features={[feature]} context={{ ...context, buildGitSha: "" }} /></MemoryRouter>);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Clearer local search tools.")).toBeTruthy();
    expect(screen.getByText(/Not available in this build/)).toBeTruthy();
  });
});
