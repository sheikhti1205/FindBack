import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodError } from "zod";
import { verifyToken } from "../domain/authService.js";
import { AppError } from "../domain/helpers.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

function readBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

/** Attach userId when a valid Bearer token is present; never rejects. */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = readBearer(req);
  if (token) {
    try {
      req.userId = verifyToken(token).userId;
    } catch {
      // leave unauthenticated
    }
  }
  next();
};

/** Require a valid Bearer token. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = readBearer(req);
  if (!token) return next(new AppError(401, "Authentication required"));
  try {
    req.userId = verifyToken(token).userId;
  } catch {
    return next(new AppError(401, "Invalid or expired token"));
  }
  next();
};

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof SyntaxError) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }
  const zodError = err as ZodError;
  if (zodError && typeof zodError === "object" && Array.isArray(zodError.issues)) {
    const issues = zodError.issues.map((i) => ({
      field: i.path.join(".") || "_",
      message: i.message,
    }));
    res.status(400).json({ error: "Validation failed", issues });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}

/** Async route wrapper (Express 5 already forwards rejects; kept for clarity). */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}
