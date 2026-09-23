import { describe, expect, it } from "vitest";
import request from "supertest";
import { registerAgent, app, seededPostId } from "./helpers.js";
import { onGatewayEvent, emitGateway } from "../realtime/gateway.js";

describe("social features: reactions, ratings, comments, realtime", () => {
  it("one reaction per user; can switch and remove (live count)", async () => {
    const agent1 = await registerAgent();
    const agent2 = await registerAgent();
    const postId = await seededPostId();

    const like1 = await request(app)
      .post(`/posts/${postId}/react`)
      .set("Authorization", `Bearer ${agent1.token}`)
      .send({ type: "LIKE" })
      .expect(200);
    const likeAfterA1 = like1.body.likeCount as number;
    const dislikeAfterA1 = like1.body.dislikeCount as number;

    // a second real user liking increments the live count by exactly one
    const like2 = await request(app)
      .post(`/posts/${postId}/react`)
      .set("Authorization", `Bearer ${agent2.token}`)
      .send({ type: "LIKE" })
      .expect(200);
    expect(like2.body.likeCount).toBe(likeAfterA1 + 1);

    // agent1 cannot like twice: counts unchanged
    const likeAgain = await request(app)
      .post(`/posts/${postId}/react`)
      .set("Authorization", `Bearer ${agent1.token}`)
      .send({ type: "LIKE" })
      .expect(200);
    expect(likeAgain.body.likeCount).toBe(likeAfterA1 + 1);

    // agent1 switches to DISLIKE
    const dislike = await request(app)
      .post(`/posts/${postId}/react`)
      .set("Authorization", `Bearer ${agent1.token}`)
      .send({ type: "DISLIKE" })
      .expect(200);
    expect(dislike.body.likeCount).toBe(likeAfterA1);
    expect(dislike.body.dislikeCount).toBe(dislikeAfterA1 + 1);
    expect(dislike.body.myReaction).toBe("DISLIKE");

    // remove
    const removed = await request(app)
      .post(`/posts/${postId}/react`)
      .set("Authorization", `Bearer ${agent1.token}`)
      .send({ type: null })
      .expect(200);
    expect(removed.body.myReaction).toBeNull();
    expect(removed.body.dislikeCount).toBe(dislikeAfterA1);

    await request(app).post(`/posts/${postId}/react`).send({ type: "LIKE" }).expect(401);
  });

  it("rates 1-5 once per user and updates live average", async () => {
    const agent = await registerAgent();
    const postId = await seededPostId();

    const first = await request(app)
      .put(`/posts/${postId}/rating`)
      .set("Authorization", `Bearer ${agent.token}`)
      .send({ score: 4 })
      .expect(200);
    expect(first.body.ratingAvg).toBe(4);
    expect(first.body.ratingCount).toBeGreaterThan(0);

    // update own rating
    const second = await request(app)
      .put(`/posts/${postId}/rating`)
      .set("Authorization", `Bearer ${agent.token}`)
      .send({ score: 2 })
      .expect(200);
    expect(second.body.score).toBe(2);
    const before = second.body.ratingCount as number;

    // unchanged after update
    const again = await request(app)
      .put(`/posts/${postId}/rating`)
      .set("Authorization", `Bearer ${agent.token}`)
      .send({ score: 5 })
      .expect(200);
    expect(again.body.ratingCount).toBe(before);

    await request(app)
      .put(`/posts/${postId}/rating`)
      .set("Authorization", `Bearer ${agent.token}`)
      .send({ score: 9 })
      .expect(400);
  });

  it("adds + lists + deletes comments", async () => {
    const agent = await registerAgent();
    const postId = await seededPostId();

    await request(app).post(`/posts/${postId}/comments`).send({ body: "nope" }).expect(401);

    const added = await request(app)
      .post(`/posts/${postId}/comments`)
      .set("Authorization", `Bearer ${agent.token}`)
      .send({ body: "I think this is mine, please check!" })
      .expect(201);
    expect(added.body.author.id).toBe(agent.user.id);

    const list = await request(app).get(`/posts/${postId}/comments`).expect(200);
    const ids = (list.body as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(added.body.id as string);

    const other = await registerAgent();
    await request(app)
      .delete(`/posts/${postId}/comments/${added.body.id}`)
      .set("Authorization", `Bearer ${other.token}`)
      .expect(403);
    await request(app)
      .delete(`/posts/${postId}/comments/${added.body.id}`)
      .set("Authorization", `Bearer ${agent.token}`)
      .expect(200);
  });

  it("comment delete policy: author yes, post owner yes, unrelated denied 403", async () => {
    const owner = await registerAgent("owner");
    const commenter = await registerAgent("commenter");
    const stranger = await registerAgent("stranger");
    const created = await request(app)
      .post("/posts")
      .set("Authorization", `Bearer ${owner.token}`)
      .send({
        type: "LOST",
        title: "Blue pencil case lost near the Science building",
        description: "A blue zip pencil case with several pens and a ruler was left near the entrance.",
        category: "Books & Stationery",
        eventDate: "2026-09-08",
      })
      .expect(201);
    const postId = (created.body as { id: string }).id;

    const first = await request(app)
      .post(`/posts/${postId}/comments`)
      .set("Authorization", `Bearer ${commenter.token}`)
      .send({ body: "author deletes own comment" })
      .expect(201);
    await request(app)
      .delete(`/posts/${postId}/comments/${first.body.id}`)
      .set("Authorization", `Bearer ${commenter.token}`)
      .expect(200);

    const second = await request(app)
      .post(`/posts/${postId}/comments`)
      .set("Authorization", `Bearer ${commenter.token}`)
      .send({ body: "owner moderates this comment" })
      .expect(201);
    await request(app)
      .delete(`/posts/${postId}/comments/${second.body.id}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .expect(200);

    const third = await request(app)
      .post(`/posts/${postId}/comments`)
      .set("Authorization", `Bearer ${commenter.token}`)
      .send({ body: "stranger must be denied" })
      .expect(201);
    const denied = await request(app)
      .delete(`/posts/${postId}/comments/${third.body.id}`)
      .set("Authorization", `Bearer ${stranger.token}`)
      .expect(403);
    expect(String(denied.body?.error ?? "")).not.toMatch(/your own/i);
  });

  it("emits realtime events on comment/reaction/rating changes", async () => {
    const events: { event: string; payload: unknown }[] = [];
    const off = onGatewayEvent((event, payload) => events.push({ event, payload }));
    try {
      const agent = await registerAgent();
      const postId = await seededPostId();
      await request(app)
        .post(`/posts/${postId}/comments`)
        .set("Authorization", `Bearer ${agent.token}`)
        .send({ body: "realtime hello" })
        .expect(201);
      await request(app)
        .post(`/posts/${postId}/react`)
        .set("Authorization", `Bearer ${agent.token}`)
        .send({ type: "LIKE" })
        .expect(200);
      await request(app)
        .put(`/posts/${postId}/rating`)
        .set("Authorization", `Bearer ${agent.token}`)
        .send({ score: 3 })
        .expect(200);

      const names = events.map((e) => e.event);
      expect(names).toContain("comment:added");
      expect(names).toContain("reaction:changed");
      expect(names).toContain("rating:changed");
      const comment = events.find((e) => e.event === "comment:added")!;
      expect((comment.payload as { postId: string }).postId).toBe(postId);
    } finally {
      off();
    }
  });

  it("gateway supports subscribing and unsubscribing", async () => {
    let got = 0;
    const off = onGatewayEvent(() => {
      got += 1;
    });
    emitGateway("feed:changed", {});
    emitGateway("feed:changed", {});
    expect(got).toBe(2);
    off();
    emitGateway("feed:changed", {});
    expect(got).toBe(2);
  });
});
