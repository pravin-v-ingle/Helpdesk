import express from "express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.ts";
import { healthRouter } from "./routes/health.ts";
import { meRouter } from "./routes/me.ts";
import { usersRouter } from "./routes/users.ts";
import { blockPublicSignUp } from "./middleware/block-public-sign-up.ts";
import { errorHandler, notFound } from "./middleware/error-handler.ts";

export function createApp() {
  const app = express();

  // Order matters here. The sign-up block has to come first, or Better Auth's
  // wildcard below would answer the request and open self-registration.
  app.all(["/api/auth/sign-up", "/api/auth/sign-up/*splat"], blockPublicSignUp);

  // Better Auth reads the raw request stream itself, so it has to be mounted
  // before express.json() consumes the body. `*splat` is Express 5's named
  // wildcard syntax; a bare `*` no longer matches.
  app.all("/api/auth/*splat", toNodeHandler(auth));

  app.use(express.json());

  // Routes
  app.use("/api/health", healthRouter);
  app.use("/api/me", meRouter);
  app.use("/api/users", usersRouter);

  // 404 for anything unmatched, then the central error handler last.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
