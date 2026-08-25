import express from "express";
import { healthRouter } from "./routes/health.ts";
import { errorHandler, notFound } from "./middleware/error-handler.ts";

export function createApp() {
  const app = express();

  app.use(express.json());

  // Routes
  app.use("/api/health", healthRouter);

  // 404 for anything unmatched, then the central error handler last.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
