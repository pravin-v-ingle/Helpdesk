import express from "express";
import { toNodeHandler } from "better-auth/node";
import { env } from "./env.ts";
import { auth, CLIENT_IP_HEADER } from "./lib/auth.ts";
import { healthRouter } from "./routes/health.ts";
import { meRouter } from "./routes/me.ts";
import { usersRouter } from "./routes/users.ts";
import { blockPublicSignUp } from "./middleware/block-public-sign-up.ts";
import { errorHandler, notFound } from "./middleware/error-handler.ts";

export function createApp() {
  const app = express();

  // `req.ip` is the socket address unless the request came through one of
  // the proxies in TRUSTED_PROXIES, in which case Express walks
  // X-Forwarded-For back to the first untrusted hop. `false` trusts nothing.
  app.set("trust proxy", env.trustedProxies.length > 0 ? env.trustedProxies : false);

  // Better Auth only sees headers, not the socket, so it cannot tell a real
  // proxy header from one the client typed. Hand it Express's answer in a
  // header of our own, overwriting whatever arrived, so the rate limiter keys
  // on the address Express resolved above and nothing the client controls.
  app.use("/api/auth", (req, _res, next) => {
    if (req.ip) req.headers[CLIENT_IP_HEADER] = req.ip;
    else delete req.headers[CLIENT_IP_HEADER];
    next();
  });

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
