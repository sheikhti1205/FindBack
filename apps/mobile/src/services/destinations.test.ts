import { describe, expect, it } from "vitest";
import { isSafeInternalRoute } from "../utils/authReturnTo";
import {
  DESTINATIONS,
  destinationFor,
  resolveDestination,
  settingsDestinations,
  settingsSectionFor,
  SETTINGS_PLACEMENT,
  type DestinationContext,
} from "./destinations";

const WEB: DestinationContext = { platform: "web", signedIn: true, capabilities: [] };

describe("the navigation catalogue", () => {
  it("carries one unique record per id", () => {
    const ids = DESTINATIONS.map((destination) => destination.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const destination of DESTINATIONS) {
      expect(destination.title.length).toBeGreaterThan(0);
      expect(destination.keywords.length).toBeGreaterThan(0);
      expect(destination.platforms.length).toBeGreaterThan(0);
    }
  });

  it("only names allowlisted internal routes", () => {
    for (const destination of DESTINATIONS) {
      expect(isSafeInternalRoute(destination.route), destination.id).toBe(true);
    }
  });

  it("keeps on-device tools out of the web catalogue", () => {
    // Owner feedback 2026-11-06: the web build has no downloads or on-device
    // inference, so neither row may be advertised or resolved there. The
    // Android build is untouched.
    const web = settingsDestinations(WEB).map((destination) => destination.id);
    expect(web).not.toContain("local-intelligence");
    for (const id of ["local-intelligence", "downloaded-models"]) {
      expect(resolveDestination(id, WEB)).toEqual({ kind: "unavailable", reason: "platform" });
      expect(resolveDestination(id, { ...WEB, platform: "android" }).kind).toBe("available");
    }
  });

  it("places every Settings row on a real destination and every placed id in the catalogue", () => {
    for (const { id } of SETTINGS_PLACEMENT) {
      expect(destinationFor(id), id).not.toBeNull();
      expect(settingsSectionFor(id), id).not.toBeNull();
    }
    const placed = settingsDestinations(WEB).map((destination) => destination.id);
    expect(placed).toContain("chat-preferences");
    expect(placed).toContain("backup");
    expect(new Set(placed).size).toBe(placed.length);
  });

  it("finds Chat preferences through the shared destination catalogue", () => {
    const entry = settingsDestinations(WEB).find((destination) => destination.id === "chat-preferences");
    expect(entry?.route).toBe("/settings/privacy/messages");
    expect(resolveDestination("chat-preferences", WEB)).toEqual({
      kind: "available",
      route: "/settings/privacy/messages",
    });
  });

  it("refuses unknown, retired and caller-incompatible ids instead of defaulting", () => {
    // The retired pre-S5 id and a staff-only console destination are both
    // unknown to the consumer catalogue: neither may resolve to a route.
    expect(resolveDestination("cloud-connections", WEB)).toEqual({ kind: "unavailable", reason: "unknown" });
    expect(resolveDestination("moderation-queue", WEB)).toEqual({ kind: "unavailable", reason: "unknown" });
    expect(resolveDestination("account", { platform: "web", signedIn: false, capabilities: [] }))
      .toEqual({ kind: "unavailable", reason: "auth" });
    expect(resolveDestination("account", { platform: "android", signedIn: true, capabilities: [] }))
      .toEqual({ kind: "available", route: "/settings/account" });
  });
});
