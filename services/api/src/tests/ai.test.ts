import { describe, expect, it } from "vitest";
import request from "supertest";
import { registerAgent, app } from "./helpers.js";
import { fallbackAnswer } from "../providers/aiProvider.js";

describe("AI help assistant", () => {
  it("requires auth", async () => {
    await request(app).post("/ai/help").send({ question: "hi" }).expect(401);
  });

  it("returns a deterministic answer when no LLM is configured", async () => {
    const agent = await registerAgent();
    const res = await request(app)
      .post("/ai/help")
      .set("Authorization", `Bearer ${agent.token}`)
      .send({ question: "How do I report a lost item?" })
      .expect(200);
    expect(res.body.source).toBe("fallback");
    expect(res.body.text.toLowerCase()).toContain("lost");
  });

  it("help keywords map to useful answers", async () => {
    expect(fallbackAnswer("how do I search for things?")).toContain("Search");
    expect(fallbackAnswer("verify my phone")).toContain("code");
    expect(fallbackAnswer("hello")).toContain("FindBack");
    // off-topic is politely declined
    expect(fallbackAnswer("who wrote Hamlet?")).toContain("only help with FindBack");
  });

  it("validates question presence", async () => {
    const agent = await registerAgent();
    await request(app)
      .post("/ai/help")
      .set("Authorization", `Bearer ${agent.token}`)
      .send({ question: "" })
      .expect(400);
  });
});
