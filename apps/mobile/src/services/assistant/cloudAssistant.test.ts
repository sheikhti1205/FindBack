import { describe, expect, it } from "vitest";
import { executeCloudAssistantMessage } from "./cloudAssistant";
import { startFlow } from "./guidedAssistantController";

describe("OpenRouter guided assistant", () => {
  it("accepts only bounded supported search filters for the existing search route", async () => {
    const result = await executeCloudAssistantMessage(startFlow("search"), "red backpack", async () =>
      JSON.stringify({ query: "red backpack", category: "invalid category", status: "LOST", sql: "delete from posts" }));
    expect(result.snapshot.searchFilters).toEqual({ query: "red backpack", status: "LOST" });
    expect(result.snapshot.state).toBe("ready");
    expect(JSON.stringify(result.snapshot)).not.toContain("delete from posts");
  });

  it("rejects malformed generated report slots before they enter the form handoff", async () => {
    const result = await executeCloudAssistantMessage(startFlow("lost"), "I lost keys", async () =>
      JSON.stringify({ title: "A".repeat(500), description: "keys", category: "INVALID", dateText: "2999-01-01" }));
    expect(result.snapshot.patch.title).toBeUndefined();
    expect(result.snapshot.patch.category).toBeUndefined();
    expect(result.snapshot.patch.eventDate).toBeUndefined();
    expect(result.snapshot.state).not.toBe("ready");
  });

  it("keeps a grounded fallback when cloud generation is unavailable", async () => {
    const result = await executeCloudAssistantMessage(startFlow("search"), "black keys", async () => { throw new Error("offline"); });
    expect(result.snapshot.searchFilters?.query).toBe("black keys");
    expect(result.replySource).toBe("grounded");
  });

  it("steps a collecting report deterministically without a key (category alias, then date question)", async () => {
    const noKey = async () => { throw new Error("not connected"); };
    const afterKeys = await executeCloudAssistantMessage(startFlow("lost"), "Keys", noKey);
    expect(afterKeys.snapshot.patch.category).toBe("Keys");
    expect(afterKeys.snapshot.missingFields[0]).toBe("date");
    expect(afterKeys.replySource).toBe("grounded");
    const afterDate = await executeCloudAssistantMessage(afterKeys.snapshot, "2026-09-01", noKey);
    expect(afterDate.snapshot.patch.eventDate).toBe("2026-09-01");
    expect(afterDate.snapshot.missingFields).toContain("location");
  });

  it("collects deterministically mid-flow without a key (alias applied, title left for longer input)", async () => {
    const noKey = async () => { throw new Error("not connected"); };
    const result = await executeCloudAssistantMessage(startFlow("lost"), "I lost keys", noKey);
    expect(result.snapshot.patch.category).toBe("Keys");
    expect(result.snapshot.patch.title).toBeUndefined();
    expect(result.snapshot.state).not.toBe("ready");
    expect(result.replySource).toBe("grounded");
  });

  it("titles a fresh null-snapshot report deterministically without a key", async () => {
    const noKey = async () => { throw new Error("not connected"); };
    const result = await executeCloudAssistantMessage(null, "lost black wallet", noKey);
    expect(result.snapshot.flow).toBe("lost");
    expect(result.snapshot.patch.title).toBe("lost black wallet");
    expect(result.replySource).toBe("grounded");
  });
});
