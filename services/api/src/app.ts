import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express, { type Express, type Request, type RequestHandler } from "express";
import multer from "multer";
import { createYoga } from "graphql-yoga";
import {
  changeStatusSchema,
  emailVerificationSendSchema,
  emailVerificationVerifySchema,
  refreshSchema,
  usernameCheckQuerySchema,
  verifyChallengeSchema,
} from "@findback/shared";
import {
  addComment,
  deleteComment,
  listComments,
} from "./domain/commentsService.js";
import {
  changePostStatus,
  createPost,
  deletePost,
  feed,
  getPost,
  myPosts,
  updatePost,
} from "./domain/postsService.js";
import { checkUsername, me } from "./domain/authService.js";
import { AppError } from "./domain/helpers.js";
import { react } from "./domain/reactionsService.js";
import { rate } from "./domain/ratingsService.js";
import { recordUpload } from "./domain/storageService.js";
import { activityReport, reportToCsv } from "./domain/reportingService.js";
import { aiAssistantProvider } from "./providers/aiProvider.js";
import { graphqlSchema } from "./graphql/schema.js";
import { config } from "./config.js";
import {
  AuthRefreshUnsupportedError,
  getAuthProvider,
  type AuthRegistrationResult,
  type AuthSession,
  type VerificationChannel,
  type VerificationTarget,
} from "./auth/index.js";
import { errorHandler, optionalAuth, requireAuth } from "./middleware/http.js";

const zodSchemas = {
  usernameCheckQuery: usernameCheckQuerySchema,
  verifyChallenge: verifyChallengeSchema,
  emailVerificationSend: emailVerificationSendSchema,
  emailVerificationVerify: emailVerificationVerifySchema,
  refresh: refreshSchema,
  changeStatus: changeStatusSchema,
};

/**
 * Public REST shape of an authenticated session. Optional fields stay
 * `undefined` for providers without them (the local JWT has no refresh/expiry),
 * and `JSON.stringify` omits them, preserving the legacy `{ token, user }`.
 */
function sessionPayload(session: AuthSession) {
  return {
    token: session.token,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
    expiresAt: session.expiresAt,
    user: session.user,
  };
}

/**
 * Registration is a union: Supabase with email confirmation ON returns a
 * pending account with no token, while an immediate session (local, or Supabase
 * when confirmation is off) returns the full session. No fake token is ever
 * issued for a pending signup.
 */
function registrationPayload(result: AuthRegistrationResult) {
  if (result.session) {
    return { ...sessionPayload(result.session), emailVerificationRequired: false };
  }
  return {
    user: result.user,
    emailVerificationRequired: true,
    email: result.email,
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^image\/(png|jpe?g|webp|gif)$/;
    if (!allowed.test(file.mimetype)) {
      cb(new Error("Only PNG, JPG/JPEG, WEBP and GIF images are allowed"));
      return;
    }
    cb(null, true);
  },
});

/** Map Multer rejections (bad MIME, too large) to clean 400 responses. */
function uploadSingle(field: string): RequestHandler {
  return (req, res, next) => {
    upload.single(field)(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        const message = err.code === "LIMIT_FILE_SIZE" ? "File too large (max 8 MB)" : err.message;
        return next(new AppError(400, message));
      }
      return next(new AppError(400, err instanceof Error ? err.message : "Invalid upload"));
    });
  };
}

function parseQuery<T>(schema: { parse: (v: unknown) => T }, raw: Request["query"]): T {
  return schema.parse(raw);
}

function paramOf(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}


export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  // ---- health ----
  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "findback-api", uptime: process.uptime() });
  });

  // ---- auth ----
  app.post("/auth/register", async (req, res) => {
    const result = await getAuthProvider().register(req.body);
    res.status(201).json(registrationPayload(result));
  });
  app.post("/auth/login", async (req, res) => {
    res.json(sessionPayload(await getAuthProvider().login(req.body)));
  });
  app.post("/auth/refresh", async (req, res) => {
    const body = parseQuery(zodSchemas.refresh, req.body);
    try {
      res.json(sessionPayload(await getAuthProvider().refresh(body.refreshToken)));
    } catch (err) {
      // The local provider has no refresh concept; report the capability gap
      // rather than a generic 500. The token itself is never logged.
      if (err instanceof AuthRefreshUnsupportedError) {
        throw new AppError(501, "Refresh tokens are not supported by the current auth provider");
      }
      throw err;
    }
  });
  app.post("/auth/logout", async (req, res) => {
    const header = req.headers.authorization;
    const accessToken = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    await getAuthProvider().signOut(accessToken);
    res.json({ ok: true });
  });
  app.get("/auth/me", optionalAuth, async (req, res) => {
    if (!req.userId) return res.status(401).json({ error: "Authentication required" });
    res.json({ user: await me(req.userId) });
  });

  // ---- public pending-signup email verification (no session yet) ----
  // A new Supabase signup has no access token, so these two routes are open.
  // They are narrow: EMAIL only, and never expose a code, session or identity.
  app.post("/auth/email-verification/send", async (req, res) => {
    const { email } = parseQuery(zodSchemas.emailVerificationSend, req.body);
    await getAuthProvider().sendVerificationCode({ channel: "EMAIL", email });
    // Generic response: never reveal whether an account exists (enumeration).
    res.json({ ok: true });
  });
  app.post("/auth/email-verification/verify", async (req, res) => {
    const { email, code } = parseQuery(zodSchemas.emailVerificationVerify, req.body);
    const result = await getAuthProvider().verifyVerificationCode(
      { channel: "EMAIL", email },
      code,
    );
    if (!result.session) {
      throw new AppError(400, "Email verification did not produce a session");
    }
    res.json({
      ...sessionPayload(result.session),
      emailVerified: result.emailVerified,
      phoneVerified: result.phoneVerified,
    });
  });

  // ---- users ----
  app.get("/users/check-username", async (req, res) => {
    const q = parseQuery(zodSchemas.usernameCheckQuery, req.query);
    res.json(await checkUsername(q.username));
  });

  // ---- verification ----
  app.post("/verification/:channel/send", requireAuth, async (req, res) => {
    const channel = paramOf(req, "channel") as VerificationChannel;
    if (channel !== "EMAIL" && channel !== "PHONE") {
      return res.status(400).json({ error: "channel must be EMAIL or PHONE" });
    }
    const target: VerificationTarget =
      channel === "EMAIL"
        ? { channel: "EMAIL", userId: req.userId! }
        : { channel: "PHONE", userId: req.userId! };
    res.json(await getAuthProvider().sendVerificationCode(target));
  });
  app.post("/verification/:channel/verify", requireAuth, async (req, res) => {
    const channel = paramOf(req, "channel") as VerificationChannel;
    if (channel !== "EMAIL" && channel !== "PHONE") {
      return res.status(400).json({ error: "channel must be EMAIL or PHONE" });
    }
    const body = zodSchemas.verifyChallenge.parse(req.body);
    const target: VerificationTarget =
      channel === "EMAIL"
        ? { channel: "EMAIL", userId: req.userId! }
        : { channel: "PHONE", userId: req.userId! };
    const result = await getAuthProvider().verifyVerificationCode(target, body.code);
    // Public contract today exposes only the flags; never a session/token.
    res.json({ emailVerified: result.emailVerified, phoneVerified: result.phoneVerified });
  });

  // ---- posts ----
  app.get("/posts", optionalAuth, async (req, res) => {
    res.json(await feed(req.query, req.userId));
  });
  app.post("/posts", requireAuth, async (req, res) => {
    res.status(201).json(await createPost(req.userId!, req.body));
  });
  app.get("/posts/:id", optionalAuth, async (req, res) => {
    res.json(await getPost(paramOf(req, "id"), req.userId));
  });
  app.patch("/posts/:id", requireAuth, async (req, res) => {
    res.json(await updatePost(req.userId!, paramOf(req, "id"), req.body));
  });
  app.patch("/posts/:id/status", requireAuth, async (req, res) => {
    const body = parseQuery(zodSchemas.changeStatus, req.body);
    res.json(await changePostStatus(req.userId!, paramOf(req, "id"), body.status));
  });
  app.delete("/posts/:id", requireAuth, async (req, res) => {
    await deletePost(req.userId!, paramOf(req, "id"));
    res.json({ ok: true });
  });

  // ---- my posts ----
  app.get("/me/posts", requireAuth, async (req, res) => {
    res.json(await myPosts(req.userId!, req.query));
  });

  // ---- comments ----
  app.get("/posts/:id/comments", async (req, res) => {
    res.json(await listComments(paramOf(req, "id")));
  });
  app.post("/posts/:id/comments", requireAuth, async (req, res) => {
    res.status(201).json(await addComment(req.userId!, paramOf(req, "id"), req.body));
  });
  app.delete("/posts/:postId/comments/:commentId", requireAuth, async (req, res) => {
    await deleteComment(req.userId!, paramOf(req, "postId"), paramOf(req, "commentId"));
    res.json({ ok: true });
  });

  // ---- reactions + ratings ----
  app.post("/posts/:id/react", requireAuth, async (req, res) => {
    const type = req.body?.type ?? null;
    if (type !== "LIKE" && type !== "DISLIKE" && type !== null) {
      return res.status(400).json({ error: "type must be LIKE, DISLIKE or null" });
    }
    res.json(await react(req.userId!, paramOf(req, "id"), type));
  });
  app.put("/posts/:id/rating", requireAuth, async (req, res) => {
    res.json(await rate(req.userId!, paramOf(req, "id"), req.body));
  });

  // ---- uploads ----
  app.post("/uploads", requireAuth, uploadSingle("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: file)" });
    const stored = await recordUpload(req.userId!, req.file);
    res.status(201).json({ upload: stored, message: "Use upload.id as attachmentKey when publishing" });
  });
  // Local filesystem uploads are only served when the local provider is active;
  // production stores images in Supabase Storage and serves them from there.
  if (config.dbProvider === "sqlite") {
    app.use(
      "/uploads",
      express.static(fs.existsSync(config.uploadsDir) ? config.uploadsDir : path.join(config.packageRoot, "uploads"), {
        maxAge: "7d",
        fallthrough: true,
      }),
    );
  }

  // Optionally serve a built web/SPA shell at "/" (single-container demo image).
  if (config.staticWebDir && fs.existsSync(config.staticWebDir)) {
    app.use(express.static(config.staticWebDir, { index: "index.html", maxAge: "1h" }));
  }

  // ---- AI help ----
  app.post("/ai/help", requireAuth, async (req, res) => {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question) return res.status(400).json({ error: "question is required" });
    if (question.length > 2000) return res.status(400).json({ error: "question too long" });
    res.json(await aiAssistantProvider.ask(question));
  });

  // ---- reporting ----
  // GET /reports/activity?days=14&format=csv  (JSON or CSV)
  app.get("/reports/activity", requireAuth, async (req, res) => {
    const format = String(req.query.format ?? "json");
    const report = await activityReport(req.query.days);
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="findback-activity.csv"');
      res.send(reportToCsv(report));
      return;
    }
    res.json(report);
  });

  // ---- GraphQL ----
  const yoga = createYoga({
    schema: graphqlSchema,
    graphiql: true,
    // Local demo API: surface domain error messages (auth/validation/forbidden).
    maskedErrors: false,
    context: async ({ request }) => {
      const header = request.headers.get("authorization");
      let userId: string | undefined;
      if (header?.startsWith("Bearer ")) {
        try {
          userId = (await getAuthProvider().validateAccessToken(header.slice(7))).userId;
        } catch {
          userId = undefined;
        }
      }
      return { userId };
    },
  });
  app.use("/graphql", yoga);

  app.use(errorHandler);
  return app;
}
