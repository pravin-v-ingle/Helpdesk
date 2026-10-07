/**
 * The HTTP contract of `POST /api/tickets/:id/summary`.
 *
 * Same arrangement as `tickets.polish.test.ts` beside it: the router on a bare
 * Express app with the real `express.json()`, the real `errorHandler` and the real
 * service, with only the ticket read, the model and `requireAuth` replaced from
 * `test/ai-fakes.ts`. Its own file because it is its own endpoint; its own Express
 * app and port because two files cannot share one listener.
 */
import express from "express";
import type { Server } from "node:http";
import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { HttpError } from "../middleware/error-handler.ts";
import {
  answering,
  DEFAULT_SUMMARY,
  detail,
  failing,
  getTicket,
  modelUse,
  resetFakes,
  ticketRead,
} from "../test/ai-fakes.ts";

const { ticketsRouter } = await import("./tickets.ts");
const { errorHandler } = await import("../middleware/error-handler.ts");

const app = express();
app.use(express.json());
app.use("/api/tickets", ticketsRouter);
app.use(errorHandler);

const server: Server = app.listen(0);
const { port } = server.address() as { port: number };

afterAll(() => {
  server.close();
});

/**
 * A POST with no body and no content type at all - which is how the client sends
 * it, and the thing most worth pinning here. The ticket in the path is the whole
 * input, so a summary that only worked when given an empty JSON object would be a
 * trap for the next caller.
 */
async function post(path: string) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" });
  return { status: response.status, body: await response.json() };
}

describe("POST /api/tickets/:id/summary", () => {
  beforeEach(() => {
    resetFakes();
    modelUse.model = answering(DEFAULT_SUMMARY);
  });

  it("answers 200 with the summary and no request body", async () => {
    const response = await post("/api/tickets/7/summary");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ summary: DEFAULT_SUMMARY });
  });

  it("summarises the ticket named in the path", async () => {
    await post("/api/tickets/42/summary");
    expect(getTicket).toHaveBeenCalledWith(42);
  });

  /**
   * Nothing is stored, so asking twice is allowed and each answer is its own.
   * This is the endpoint's whole character: a summary is generated, never
   * fetched, which is why no summary is kept anywhere.
   */
  it("summarises again on a second request", async () => {
    expect((await post("/api/tickets/7/summary")).body).toEqual({ summary: DEFAULT_SUMMARY });

    modelUse.model = answering("A different summary, because the thread moved on.");

    expect((await post("/api/tickets/7/summary")).body).toEqual({
      summary: "A different summary, because the thread moved on.",
    });
    expect(getTicket).toHaveBeenCalledTimes(2);
  });

  /** The same rule the rest of the router follows for an unusable id. */
  it.each(["abc", "0", "-1", "1.5", "2147483648"])("answers 404 for the id %p", async (id) => {
    const response = await post(`/api/tickets/${id}/summary`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Ticket not found" });
    expect(getTicket).not.toHaveBeenCalled();
  });

  it("answers 404 when the ticket does not exist", async () => {
    ticketRead.error = new HttpError(404, "Ticket not found");

    expect(await post("/api/tickets/7/summary")).toEqual({
      status: 404,
      body: { error: "Ticket not found" },
    });
  });

  /** A 400 rather than an empty 200: there is nothing here to summarise. */
  it("answers 400 for a ticket with no messages", async () => {
    ticketRead.ticket = detail({ messages: [] });

    expect(await post("/api/tickets/7/summary")).toEqual({
      status: 400,
      body: { error: "There are no messages on this ticket to summarise." },
    });
  });

  it("answers 503 when the server has no API key", async () => {
    modelUse.error = new HttpError(503, "AI features are not configured on this server.");

    expect(await post("/api/tickets/7/summary")).toEqual({
      status: 503,
      body: { error: "AI features are not configured on this server." },
    });
  });

  it("answers 502 when the provider fails", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    modelUse.model = failing(new Error("429 Rate limit reached"));

    expect(await post("/api/tickets/7/summary")).toEqual({
      status: 502,
      body: { error: "Could not summarise the ticket just now. Please try again." },
    });

    logged.mockRestore();
  });

  it("answers 502 when the model returns nothing usable", async () => {
    modelUse.model = answering("   ");

    expect(await post("/api/tickets/7/summary")).toEqual({
      status: 502,
      body: { error: "The model returned an empty summary. Please try again." },
    });
  });

  it("answers 500 for an unexpected failure", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    ticketRead.error = new TypeError("undefined is not a function");

    const response = await post("/api/tickets/7/summary");
    expect(response.status).toBe(500);
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });
});
