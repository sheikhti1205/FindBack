import { describe, expect, it } from "vitest";
import request from "supertest";
import type { PostItem } from "@findback/shared";
import { registerAgent, app } from "./helpers.js";

function validPost(overrides: Record<string, unknown> = {}) {
  return {
    type: "LOST",
    title: "Blue pencil case lost near the Science building",
    description: "A blue zip pencil case with several pens and a ruler was left near the entrance.",
    category: "Books & Stationery",
    eventDate: "2026-09-08",
    locationLabel: "Science Building, University of Chittagong",
    latitude: 22.4688,
    longitude: 91.7835,
    youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    ...overrides,
  };
}

describe("posts + feed", () => {
  it("requires auth to create a post", async () => {
    await request(app).post("/posts").send(validPost()).expect(401);
  });

  it("creates a post and returns it with counts", async () => {
    const agent = await registerAgent();
    const res = await request(app)
      .post("/posts")
      .set("Authorization", `Bearer ${agent.token}`)
      .send(validPost())
      .expect(201);
    const post = res.body as PostItem;
    expect(post.id).toBeTruthy();
    expect(post.type).toBe("LOST");
    expect(post.status).toBe("OPEN");
    expect(post.likeCount).toBe(0);
    expect(post.author.username).toBe(agent.user.username);
  });

  it("rejects posts missing mandatory fields", async () => {
    const agent = await registerAgent();
    const res = await request(app)
      .post("/posts")
      .set("Authorization", `Bearer ${agent.token}`)
      .send({ type: "LOST", title: "hi" })
      .expect(400);
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  it("paginates the feed with a cursor and preserves filters", async () => {
    const page1 = await request(app)
      .get("/posts")
      .query({ limit: 5, type: "LOST" })
      .expect(200);
    expect(page1.body.items.length).toBe(5);
    expect(page1.body.total).toBeGreaterThan(5);
    expect(page1.body.nextCursor).toBeTruthy();
    for (const p of page1.body.items as PostItem[]) expect(p.type).toBe("LOST");

    const page2 = await request(app)
      .get("/posts")
      .query({ limit: 5, type: "LOST", cursor: page1.body.nextCursor })
      .expect(200);
    const ids1 = new Set((page1.body.items as PostItem[]).map((p) => p.id));
    for (const p of page2.body.items as PostItem[]) expect(ids1.has(p.id)).toBe(false);
  });

  it("searches title/description", async () => {
    const res = await request(app)
      .get("/posts")
      .query({ q: "calculator" })
      .expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    const allMatch = (res.body.items as PostItem[]).every(
      (p) => p.title.toLowerCase().includes("calculator") || p.description.toLowerCase().includes("calculator"),
    );
    expect(allMatch).toBe(true);
  });

  it("filters by category", async () => {
    const res = await request(app).get("/posts").query({ category: "Keys" }).expect(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const p of res.body.items as PostItem[]) expect(p.category).toBe("Keys");
  });

  it("gets a post detail", async () => {
    const feedRes = await request(app).get("/posts").query({ limit: 1 }).expect(200);
    const id = (feedRes.body.items as PostItem[])[0]!.id;
    const res = await request(app).get(`/posts/${id}`).expect(200);
    expect((res.body as PostItem).id).toBe(id);
  });

  it("only the owner can change status or update a post", async () => {
    const owner = await registerAgent();
    const other = await registerAgent();
    const created = await request(app)
      .post("/posts")
      .set("Authorization", `Bearer ${owner.token}`)
      .send(validPost())
      .expect(201);
    const id = (created.body as PostItem).id;

    await request(app)
      .patch(`/posts/${id}/status`)
      .set("Authorization", `Bearer ${other.token}`)
      .send({ status: "CLOSED" })
      .expect(403);

    const res = await request(app)
      .patch(`/posts/${id}/status`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ status: "RECOVERED" })
      .expect(200);
    expect((res.body as PostItem).status).toBe("RECOVERED");

    await request(app)
      .patch(`/posts/${id}`)
      .set("Authorization", `Bearer ${other.token}`)
      .send({ title: "hacked" })
      .expect(403);
    await request(app)
      .patch(`/posts/${id}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({ title: "New title" })
      .expect(200);
  });

  it("lists my posts", async () => {
    const agent = await registerAgent();
    await request(app)
      .post("/posts")
      .set("Authorization", `Bearer ${agent.token}`)
      .send(validPost({ type: "FOUND" }))
      .expect(201);
    const res = await request(app)
      .get("/me/posts")
      .set("Authorization", `Bearer ${agent.token}`)
      .expect(200);
    expect(res.body.items.length).toBe(1);
    expect((res.body.items as PostItem[])[0]!.author.id).toBe(agent.user.id);
  });
});
