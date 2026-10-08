/**
 * The HTTP contract of `POST /api/tickets/:id/polish`: the status codes, the
 * response shape, and what the body is allowed to be.
 *
 * Named for the one route it covers rather than `tickets.test.ts`, because the
 * rest of that router has no unit tests - a file claiming the whole thing would
 * misrepresent what is covered.
 *
 * The router is mounted on a bare Express app with the real `express.json()` and
 * the real `errorHandler`, and the real service behind it, so everything between
 * the request and the model is the genuine article. Only the two outside edges
 * are replaced - the ticket read and the model - plus `requireAuth`, which would
 * otherwise want a session out of Postgres. They all come from
 * `test/fakes.ts`; that file explains why every fake these features share is
 * registered in one place rather than per test file.
 *
 * So these are route tests that happen to run the service too. That is
 * deliberate: a route this thin has almost no behaviour of its own, and the thing
 * worth pinning is that a refusal from four layers down arrives at the client as
 * the right status with the right sentence.
 */
import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { HttpError } from "../middleware/error-handler.ts";
import {
  answering,
  DEFAULT_POLISHED,
  type ModelCall,
  failing,
  getTicket,
  modelUse,
  resetFakes,
  ticketRead,
} from "../test/fakes.ts";

const { ticketsRouter } = await import("./tickets.ts");
const { errorHandler } = await import("../middleware/error-handler.ts");

const app = express();
app.use(express.json());
app.use("/api/tickets", ticketsRouter);
app.use(errorHandler);

// Port 0: the OS picks a free one, so a dev server already on 3000 is no obstacle
// and two runs cannot collide.
const server: Server = app.listen(0);
const { port } = server.address() as { port: number };

afterAll(() => {
  server.close();
});

async function post(path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

/** The draft as it reached the model, which is the far end of the request. */
function draftSentToModel(): string {
  const call: ModelCall | undefined = modelUse.model.doGenerateCalls[0];
  const user = call?.prompt[1];
  if (!user || user.role !== "user") return "";

  const text = user.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return text.slice(text.indexOf("The agent's draft reply to rewrite:")).trim();
}

describe("POST /api/tickets/:id/polish", () => {
  beforeEach(resetFakes);

  /**
   * `{ body }` in, `{ body }` out, and a 200 rather than the 201 the reply
   * endpoint answers with: nothing was created, because nothing was stored.
   */
  it("answers 200 with the rewritten draft", async () => {
    const response = await post("/api/tickets/7/polish", { body: "fixed ur enrolment" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ body: DEFAULT_POLISHED });
  });

  it("polishes against the ticket named in the path", async () => {
    await post("/api/tickets/42/polish", { body: "a draft" });
    expect(getTicket).toHaveBeenCalledWith(42);
  });

  /**
   * The shared schema trims, so what travels is the draft the agent really wrote
   * rather than whatever whitespace the textarea collected around it.
   */
  it("sends a trimmed draft", async () => {
    await post("/api/tickets/7/polish", { body: "  fixed ur enrolment\n\n" });
    expect(draftSentToModel().endsWith("fixed ur enrolment")).toBe(true);
  });

  /**
   * `ticketReplySchema`, the same schema the composer runs - so the 400 carries
   * the sentence the form would have shown. A draft has to be a usable reply
   * before it is worth a round trip, which is why nothing downstream is reached.
   */
  it("refuses a blank draft with the form's own message", async () => {
    const response = await post("/api/tickets/7/polish", { body: "   " });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Reply is required." });
    expect(getTicket).not.toHaveBeenCalled();
  });

  it("refuses a missing body", async () => {
    const response = await post("/api/tickets/7/polish", {});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Reply is required." });
    expect(getTicket).not.toHaveBeenCalled();
  });

  it("refuses a draft longer than a reply may be", async () => {
    const response = await post("/api/tickets/7/polish", { body: "y".repeat(10_001) });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Reply must be at most 10,000 characters." });
    expect(getTicket).not.toHaveBeenCalled();
  });

  /**
   * An id that is not a ticket number is a 404, not a 400 - the rule the rest of
   * the router follows: `/api/tickets/abc` names no ticket, and "Ticket not found"
   * is the message the detail page has to render anyway. `2147483648` is past
   * what the `int4` column can hold, so it names no ticket either.
   */
  it.each(["abc", "0", "-1", "1.5", "2147483648"])("answers 404 for the id %p", async (id) => {
    const response = await post(`/api/tickets/${id}/polish`, { body: "a draft" });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Ticket not found" });
    expect(getTicket).not.toHaveBeenCalled();
  });

  it("answers 404 when the ticket does not exist", async () => {
    ticketRead.error = new HttpError(404, "Ticket not found");

    expect(await post("/api/tickets/7/polish", { body: "a draft" })).toEqual({
      status: 404,
      body: { error: "Ticket not found" },
    });
  });

  /** The composer shows this one verbatim, so it travels verbatim. */
  it("answers 503 when the server has no API key", async () => {
    modelUse.error = new HttpError(503, "AI features are not configured on this server.");

    expect(await post("/api/tickets/7/polish", { body: "a draft" })).toEqual({
      status: 503,
      body: { error: "AI features are not configured on this server." },
    });
  });

  it("answers 502 when the provider fails", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    modelUse.model = failing(new Error("429 Rate limit reached"));

    expect(await post("/api/tickets/7/polish", { body: "a draft" })).toEqual({
      status: 502,
      body: { error: "Could not polish the reply just now. Please try again." },
    });

    logged.mockRestore();
  });

  it("answers 502 when the model returns nothing usable", async () => {
    modelUse.model = answering("  ");

    expect(await post("/api/tickets/7/polish", { body: "a draft" })).toEqual({
      status: 502,
      body: { error: "The model returned an empty reply. Please try again." },
    });
  });

  /**
   * Anything thrown that is not an `HttpError` is a bug, not a message for an
   * agent: it becomes a 500 and the handler logs it. Nothing claims to be a
   * sentence the client should show.
   */
  it("answers 500 for an unexpected failure", async () => {
    // The error handler logs what it could not classify, which is correct and
    // which this test would otherwise print as noise.
    const logged = spyOn(console, "error").mockImplementation(() => {});
    ticketRead.error = new TypeError("undefined is not a function");

    const response = await post("/api/tickets/7/polish", { body: "a draft" });
    expect(response.status).toBe(500);
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });
});
