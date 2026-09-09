import { describe, expect, it } from "vitest";
import request from "supertest";
import { app, registerAgent } from "./helpers.js";

describe("GET /reports/activity", () => {
  it("requires authentication", async () => {
    await request(app).get("/reports/activity").expect(401);
  });

  it("returns JSON summary when not authenticated -> still 401; with agent works", async () => {
    const agent = await registerAgent("report");
    const res = await request(app)
      .get("/reports/activity?days=30")
      .set("Authorization", `Bearer ${agent.token}`)
      .expect(200);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.totalUsers).toBeGreaterThanOrEqual(1);
    expect(res.body.summary.totalPosts).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(res.body.byDay)).toBe(true);
    expect(Array.isArray(res.body.topContributors)).toBe(true);
    expect(res.body.generatedAt).toBeTruthy();
  });

  it("rejects nonsense day windows safely", async () => {
    const agent = await registerAgent("report2");
    const res = await request(app)
      .get("/reports/activity?days=999999999&format=json")
      .set("Authorization", `Bearer ${agent.token}`)
      .expect(200);
    // clamps to 90 days, so it still works
    expect(res.body.byDay.length).toBeLessThanOrEqual(91);
  });

  it("exports CSV with headers", async () => {
    const agent = await registerAgent("report3");
    const res = await request(app)
      .get("/reports/activity?format=csv")
      .set("Authorization", `Bearer ${agent.token}`)
      .expect(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain("metric,value");
    expect(res.text).toContain("date,posts,comments,newUsers");
    expect(res.text).toContain("totalPosts");
  });
});
