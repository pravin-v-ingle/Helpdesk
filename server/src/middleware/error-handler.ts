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

  // Express's body parsers reject a body they cannot use - over the size
  // limit (413), malformed JSON (400), an unsupported charset (415) - with a
  // plain `Error` carrying a numeric `status`. Without this branch every one
  // of those becomes a 500, which tells the caller to retry something that
  // will never succeed: an email provider would keep resending an oversized
  // message for hours. The message is the parser's own and says nothing about
  // our internals, so it is safe to return.
  const status = bodyParserStatus(err);
  if (status !== undefined) {
    res.status(status).json({ error: err instanceof Error ? err.message : "Bad request" });
    return;
  }

  console.error("Unhandled error:", err);
  res.status(500).json({
    error: isProduction ? "Internal server error" : String(err),
  });
};

/**
 * A client error status the thrower attached to a plain error, or `undefined`
 * when there is none. Only 4xx is honoured: a 5xx `status` on an arbitrary
 * error is far more likely to be an unrelated field than a deliberate choice,
 * and the generic 500 above already covers that case.
 */
function bodyParserStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;

  const { status } = err as { status?: unknown };
  if (typeof status !== "number" || !Number.isInteger(status)) return undefined;
  return status >= 400 && status <= 499 ? status : undefined;
}
