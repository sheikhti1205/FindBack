import { describe, expect, it } from "vitest";
import request from "supertest";
import { registerAgent, app } from "./helpers.js";

const POSTS_QUERY = /* GraphQL */ `
  query Posts($limit: Int, $cursor: String) {
    posts(limit: $limit, cursor: $cursor) {
      items { id title likeCount ratingAvg }
      nextCursor
      total
    }
  }
`;

describe("GraphQL API", () => {
  it("serves the GraphQL endpoint and paginates posts", async () => {
    const res = await request(app)
      .post("/graphql")
      .send({ query: POSTS_QUERY, variables: { limit: 3 } })
      .expect(200);
    expect(res.body.errors).toBeUndefined();
    const items = res.body.data.posts.items as { id: string }[];
    expect(items.length).toBe(3);
    expect(typeof res.body.data.posts.total).toBe("number");
    expect(typeof res.body.data.posts.nextCursor).toBe("string");
  });

  it("requires auth for mutations", async () => {
    const res = await request(app)
      .post("/graphql")
      .send({
        query: /* GraphQL */ `
          mutation {
            createPost(input: { type: "LOST", title: "x", description: "y", category: "Keys", eventDate: "2026-09-01" }) {
              id
            }
          }
        `,
      })
      .expect(200);
    expect(res.body.errors).toBeDefined();
    expect(JSON.stringify(res.body.errors)).toContain("Authentication required");
  });

  it("creates a post and adds a comment over GraphQL", async () => {
    const agent = await registerAgent();
    const auth = { Authorization: `Bearer ${agent.token}` };
    const created = await request(app)
      .post("/graphql")
      .set(auth)
      .send({
        query: /* GraphQL */ `
          mutation Create($input: PostInput!) {
            createPost(input: $input) { id title status }
          }
        `,
        variables: {
          input: {
            type: "FOUND",
            title: "GraphQL found umbrella",
            description: "A green umbrella found beside the pond.",
            category: "Clothing",
            eventDate: "2026-09-07",
          },
        },
      })
      .expect(200);
    expect(created.body.errors).toBeUndefined();
    const postId = created.body.data.createPost.id as string;

    const commented = await request(app)
      .post("/graphql")
      .set(auth)
      .send({
        query: /* GraphQL */ `
          mutation Add($postId: ID!, $body: String!) {
            addComment(postId: $postId, body: $body) { id body }
          }
        `,
        variables: { postId, body: "via graphql" },
      })
      .expect(200);
    expect(commented.body.errors).toBeUndefined();
    expect(commented.body.data.addComment.body).toBe("via graphql");

    const reaction = await request(app)
      .post("/graphql")
      .set(auth)
      .send({
        query: /* GraphQL */ `
          mutation React($postId: ID!, $type: String) {
            reactToPost(postId: $postId, type: $type) { myReaction likeCount }
          }
        `,
        variables: { postId, type: "LIKE" },
      })
      .expect(200);
    expect(reaction.body.data.reactToPost.myReaction).toBe("LIKE");
    expect(reaction.body.data.reactToPost.likeCount).toBe(1);
  });

  it("queries a single post with its comments", async () => {
    const list = await request(app)
      .post("/graphql")
      .send({ query: POSTS_QUERY, variables: { limit: 1 } })
      .expect(200);
    const postId = list.body.data.posts.items[0].id as string;

    const res = await request(app)
      .post("/graphql")
      .send({
        query: /* GraphQL */ `
          query Post($id: ID!) {
            post(id: $id) { id title }
            comments(postId: $id) { id body }
          }
        `,
        variables: { id: postId },
      })
      .expect(200);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.post.id).toBe(postId);
    expect(Array.isArray(res.body.data.comments)).toBe(true);
  });
});
