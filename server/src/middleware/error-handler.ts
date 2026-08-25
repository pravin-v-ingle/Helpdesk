import type { ErrorRequestHandler, RequestHandler } from "express";
import { isProduction } from "../env.ts";

/** Error type services throw when they want to control the HTTP status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound: RequestHandler = (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
};

/**
 * Central error handler. Express 5 forwards rejected promises from async
 * handlers here automatically, so route handlers do not need try/catch.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }

  console.error("Unhandled error:", err);
  res.status(500).json({
    error: isProduction ? "Internal server error" : String(err),
  });
};
