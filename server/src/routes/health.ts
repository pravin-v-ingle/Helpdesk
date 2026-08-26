import { Router } from "express";
import { checkDatabase } from "../lib/prisma.ts";

export const healthRouter: Router = Router();

healthRouter.get("/", async (_req, res) => {
  const databaseUp = await checkDatabase();

  res.status(databaseUp ? 200 : 503).json({
    status: databaseUp ? "ok" : "degraded",
    database: databaseUp ? "up" : "down",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});
