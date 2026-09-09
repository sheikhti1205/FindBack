import { createSchema } from "graphql-yoga";
import type { PostStatus } from "@findback/shared";
import { addComment, deleteComment, listComments } from "../domain/commentsService.js";
import { changePostStatus, createPost, deletePost, feed, getPost, myPosts, updatePost } from "../domain/postsService.js";
import { react } from "../domain/reactionsService.js";
import { rate } from "../domain/ratingsService.js";

/**
 * GraphQL layer over the same domain services the REST layer uses.
 * Course-required "modern API layer" alongside REST. No duplicated logic.
 */

const typeDefs = /* GraphQL */ `
  scalar Date

  type User {
    id: ID!
    username: String!
    email: String!
    phone: String!
    emailVerified: Boolean!
    phoneVerified: Boolean!
    avatarUrl: String
    createdAt: String!
  }

  type Attachment {
    id: ID!
    postId: ID!
    fileUrl: String!
    mimeType: String!
    fileName: String!
    fileSize: Int!
  }

  type Post {
    id: ID!
    author: User!
    type: String!
    title: String!
    description: String!
    category: String!
    status: String!
    eventDate: String!
    latitude: Float
    longitude: Float
    locationLabel: String
    youtubeUrl: String
    attachments: [Attachment!]!
    likeCount: Int!
    dislikeCount: Int!
    ratingAvg: Float
    ratingCount: Int!
    commentCount: Int!
    createdAt: String!
    updatedAt: String!
  }

  type Comment {
    id: ID!
    postId: ID!
    author: User!
    body: String!
    createdAt: String!
  }

  type FeedPage {
    items: [Post!]!
    nextCursor: String
    total: Int!
  }

  type ReactionResult {
    postId: ID!
    likeCount: Int!
    dislikeCount: Int!
    myReaction: String
  }

  type RatingResult {
    postId: ID!
    score: Int!
    ratingAvg: Float
    ratingCount: Int!
  }

  type Query {
    posts(
      type: String
      category: String
      status: String
      q: String
      dateFrom: String
      dateTo: String
      cursor: String
      limit: Int
      sort: String
    ): FeedPage!
    post(id: ID!): Post
    myPosts(cursor: String, limit: Int): FeedPage!
    comments(postId: ID!): [Comment!]!
  }

  type Mutation {
    createPost(input: PostInput!): Post!
    updatePost(id: ID!, input: PostInput!): Post!
    changePostStatus(id: ID!, status: String!): Post!
    deletePost(id: ID!): Boolean!
    addComment(postId: ID!, body: String!): Comment!
    deleteComment(postId: ID!, commentId: ID!): Boolean!
    reactToPost(postId: ID!, type: String): ReactionResult!
    ratePost(postId: ID!, score: Int!): RatingResult!
  }

  input PostInput {
    type: String
    title: String
    description: String
    category: String
    eventDate: String
    locationLabel: String
    latitude: Float
    longitude: Float
    youtubeUrl: String
    attachmentKey: String
  }
`;

export interface GraphQLContext {
  userId: string | undefined;
}

function requireUser(ctx: GraphQLContext): string {
  if (!ctx.userId) throw new Error("Authentication required");
  return ctx.userId;
}

export const graphqlSchema = createSchema({
  typeDefs,
  resolvers: {
    Query: {
      posts: (_parent: unknown, args: Record<string, unknown>, ctx: GraphQLContext) =>
        feed(args, ctx.userId),
      post: (_parent: unknown, args: { id: string }, ctx: GraphQLContext) =>
        getPost(args.id, ctx.userId),
      myPosts: (_parent: unknown, args: Record<string, unknown>, ctx: GraphQLContext) =>
        myPosts(requireUser(ctx), args),
      comments: (_parent: unknown, args: { postId: string }) => listComments(args.postId),
    },
    Mutation: {
      createPost: (_p: unknown, args: { input: unknown }, ctx: GraphQLContext) =>
        createPost(requireUser(ctx), args.input),
      updatePost: (_p: unknown, args: { id: string; input: unknown }, ctx: GraphQLContext) =>
        updatePost(requireUser(ctx), args.id, args.input),
      changePostStatus: (_p: unknown, args: { id: string; status: string }, ctx: GraphQLContext) =>
        changePostStatus(requireUser(ctx), args.id, args.status as PostStatus),
      deletePost: (_p: unknown, args: { id: string }, ctx: GraphQLContext) => {
        deletePost(requireUser(ctx), args.id);
        return true;
      },
      addComment: (_p: unknown, args: { postId: string; body: string }, ctx: GraphQLContext) =>
        addComment(requireUser(ctx), args.postId, { body: args.body }),
      deleteComment: (_p: unknown, args: { postId: string; commentId: string }, ctx: GraphQLContext) => {
        deleteComment(requireUser(ctx), args.postId, args.commentId);
        return true;
      },
      reactToPost: (_p: unknown, args: { postId: string; type: string | null }, ctx: GraphQLContext) =>
        react(requireUser(ctx), args.postId, (args.type ?? null) as "LIKE" | "DISLIKE" | null),
      ratePost: (_p: unknown, args: { postId: string; score: number }, ctx: GraphQLContext) =>
        rate(requireUser(ctx), args.postId, { score: args.score }),
    },
  },
});
