import { Router } from "express";
import { requireAuth } from "../middleware/require-auth.ts";
import { getDashboard } from "../services/dashboard.ts";

export const dashboardRouter: Router = Router();

/**
 * The dashboard's numbers: how many tickets there are, how many are open, how
 * many the auto-resolver answered and how long a resolution takes on average -
 * plus the last 30 days of arrivals for the volume chart. Tasks 7.1 and 7.3.
 *
 * **One request for both**, and one `RepeatableRead` transaction inside it, so
 * the tiles and the chart are read from the same snapshot: 30 days that summed
 * to more tickets than the total claims exist would be a visible contradiction
 * on one screen. See the service for why that is cheap here.
 *
 * `requireAuth` with **no role check**, the same as `/api/tickets` and for the
 * same reason: this is the state of the queue, working the queue is the agent's
 * job, and the page it feeds is the home page every signed-in user lands on.
 * Nothing here is per-user - there is no "my tickets" figure - so there is
 * nothing an agent could see that is not already on the ticket list they can
 * read in full.
 *
 * A `GET` and genuinely cacheable, unlike the two AI endpoints on the ticket
 * router: it reads committed rows, costs one query and no money, and asking
 * twice gives the same answer.
 */
dashboardRouter.get("/", requireAuth, async (_req, res) => {
  // `{ metrics, dailyVolume }` - the service's own shape, two keys because they
  // are two different things the page renders separately, rather than a series
  // buried inside an object named for scalars.
  res.json(await getDashboard());
});
