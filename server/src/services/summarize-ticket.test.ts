/**
 * Unit tests for the ticket summariser. The same shape as the polisher's beside
 * it: the ticket read and the model are the only things replaced, both from
 * `test/fakes.ts`, and the model is the AI SDK's own mock so `generateText`
 * runs for real and these assertions are made against the call the service
 * actually built.
 *
 * The prompt assertions are the point of this file. A summary is read *instead of*
 * the thread, so what the model is and is not shown is the whole correctness
 * question - more so than for the polisher, where an agent still rereads their own
 * draft afterwards.
 */
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { MessageDirection, TicketStatus } from "../generated/prisma/enums.ts";
import { HttpError } from "../middleware/error-handler.ts";
import {
  answering,
  DEFAULT_SUMMARY,
  detail,
  failing,
  getTicket,
  message,
  type ModelCall,
  modelUse,
  openAiModel,
  resetFakes,
  ticketRead,
} from "../test/fakes.ts";
import { MAX_SUMMARY_LENGTH } from "./summarize-ticket.ts";

// `await import` for the function under test, not a static import: `mock.module`
// is not hoisted in Bun, and a static import can be evaluated before `fakes.ts`
// has finished registering its fakes, binding the real modules instead. The
// constant above is a plain number with no dependencies, so it is safe either way.
const { summarizeTicket } = await import("./summarize-ticket.ts");

/** The one call the model was asked to make. Fails the test if there was none. */
function call(): ModelCall {
  const calls = modelUse.model.doGenerateCalls;
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

function instructions(): string {
  const first = call().prompt[0]!;
  expect(first.role).toBe("system");
  return first.role === "system" ? first.content : "";
}

function userPrompt(): string {
  const second = call().prompt[1]!;
  expect(second.role).toBe("user");
  if (second.role !== "user") return "";

  return second.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    const { status, message: reason } = err as HttpError;
    return { status, message: reason };
  }
  throw new Error("Expected summarizeTicket to throw, but it resolved.");
}

describe("summarizeTicket", () => {
  beforeEach(() => {
    resetFakes();
    modelUse.model = answering(DEFAULT_SUMMARY);
  });

  it("returns what the model wrote", async () => {
    expect(await summarizeTicket(7)).toBe(DEFAULT_SUMMARY);
  });

  it("trims what the model wrote", async () => {
    modelUse.model = answering("\n\n  A tidy summary.  \n");
    expect(await summarizeTicket(7)).toBe("A tidy summary.");
  });

  it("reads the ticket it was asked about", async () => {
    await summarizeTicket(42);
    expect(getTicket).toHaveBeenCalledWith(42);
  });

  it("sends the summarising instructions as a system message", async () => {
    await summarizeTicket(7);

    // The wording is the service's business and gets edited freely; what this
    // pins is that the instructions are there at all and arrive as the system
    // message, rather than as something the conversation appears to say.
    expect(instructions().length).toBeGreaterThan(100);
    expect(instructions()).toContain("summarise");
  });

  /** The facts an agent would otherwise read off the Details card. */
  it("gives the ticket's own fields as well as the thread", async () => {
    ticketRead.ticket = detail({ status: TicketStatus.RESOLVED });

    await summarizeTicket(7);
    const prompt = userPrompt();

    expect(prompt).toContain("Subject: Cannot see my enrolment");
    expect(prompt).toContain("Student: Ada Lovelace");
    expect(prompt).toContain("Status: RESOLVED");
    expect(prompt).toContain("Opened: 2026-09-28T09:00:00.000Z");
    expect(prompt).toContain("Messages on the ticket: 1");
  });

  /**
   * Who said what, and when. The timestamp matters here in a way it does not
   * when polishing: "what is still outstanding" usually turns on how long ago
   * the last thing happened.
   */
  it("labels every message with its sender and its time", async () => {
    ticketRead.ticket = detail({
      messages: [
        message({ id: 1, body: "I cannot see my enrolment." }),
        message({
          id: 2,
          direction: MessageDirection.OUTBOUND,
          fromName: "Bob Agent",
          body: "Looking into it now.",
          createdAt: new Date("2026-09-28T11:30:00.000Z"),
        }),
      ],
    });

    await summarizeTicket(7);
    const prompt = userPrompt();

    expect(prompt).toContain("Student (Ada Lovelace, 2026-09-28T09:00:00.000Z):");
    expect(prompt).toContain("I cannot see my enrolment.");
    expect(prompt).toContain("Agent (Bob Agent, 2026-09-28T11:30:00.000Z):");
    expect(prompt).toContain("Looking into it now.");
  });

  /** Oldest first, as the thread is read - and as the ticket detail returns it. */
  it("keeps the conversation in the order it happened", async () => {
    ticketRead.ticket = detail({
      messages: [
        message({ id: 1, body: "the first thing said" }),
        message({ id: 2, body: "the second thing said" }),
      ],
    });

    await summarizeTicket(7);
    const prompt = userPrompt();

    expect(prompt.indexOf("the first thing said")).toBeLessThan(
      prompt.indexOf("the second thing said"),
    );
  });

  /**
   * Thirty rather than the polisher's six, because a summary is a claim about the
   * whole conversation. When the cap bites the oldest go: a summary missing the
   * opening request is visibly incomplete, where one missing the latest exchange
   * reads as complete and is not.
   */
  it("sends at most the last thirty messages", async () => {
    ticketRead.ticket = detail({
      messages: Array.from({ length: 33 }, (_, i) =>
        message({ id: i + 1, body: `message number ${i + 1}` }),
      ),
    });

    await summarizeTicket(7);
    const prompt = userPrompt();

    expect(prompt).not.toContain("message number 3:");
    expect(prompt).toContain("message number 4");
    expect(prompt).toContain("message number 33");
  });

  it("truncates a very long message rather than sending all of it", async () => {
    ticketRead.ticket = detail({ messages: [message({ body: "x".repeat(4_500) })] });

    await summarizeTicket(7);
    const prompt = userPrompt();

    expect(prompt).toContain(`${"x".repeat(4_000)}…`);
    expect(prompt).not.toContain("x".repeat(4_001));
  });

  /**
   * A model handed an empty conversation would invent one, and the invention
   * would be read as the ticket's history. Refused before it is paid for.
   */
  it("refuses a ticket with no messages without calling the model", async () => {
    ticketRead.ticket = detail({ messages: [] });

    expect(await refusal(summarizeTicket(7))).toEqual({
      status: 400,
      message: "There are no messages on this ticket to summarise.",
    });
    expect(openAiModel).not.toHaveBeenCalled();
  });

  it("asks for a cheap, low-verbosity, unstored completion", async () => {
    await summarizeTicket(7);
    const options = call();

    expect(options.maxOutputTokens).toBe(1_000);
    // `store: false` matters most on this call of the two: the prompt is the
    // entire conversation, so it carries more of a student's words than anything
    // else the system sends anywhere.
    expect(options.providerOptions?.openai).toEqual({
      reasoningEffort: "low",
      textVerbosity: "low",
      store: false,
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("does not call the model when the ticket is gone", async () => {
    ticketRead.error = new HttpError(404, "Ticket not found");

    expect(await refusal(summarizeTicket(7))).toEqual({
      status: 404,
      message: "Ticket not found",
    });
    expect(openAiModel).not.toHaveBeenCalled();
  });

  it("passes the unconfigured-server refusal through untouched", async () => {
    modelUse.error = new HttpError(503, "AI features are not configured on this server.");

    expect(await refusal(summarizeTicket(7))).toEqual({
      status: 503,
      message: "AI features are not configured on this server.",
    });
  });

  it("turns a provider failure into one 502 and logs the cause", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    modelUse.model = failing(new Error("401 Incorrect API key provided: sk-abc123"));

    const { status, message: reason } = await refusal(summarizeTicket(7));
    expect(status).toBe(502);
    expect(reason).toBe("Could not summarise the ticket just now. Please try again.");
    expect(reason).not.toContain("sk-abc123");
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  /**
   * An empty answer shown as-is would read as "this ticket has nothing in it",
   * which is a claim the model never made.
   */
  it("refuses an empty answer rather than returning it", async () => {
    modelUse.model = answering("  \n ");

    expect(await refusal(summarizeTicket(7))).toEqual({
      status: 502,
      message: "The model returned an empty summary. Please try again.",
    });
  });

  /** A summary longer than this is not a summary, which is the whole feature. */
  it("refuses a summary over the length cap", async () => {
    modelUse.model = answering("y".repeat(MAX_SUMMARY_LENGTH + 1));

    expect(await refusal(summarizeTicket(7))).toEqual({
      status: 502,
      message: "The summary came back too long to use. Please try again.",
    });
  });

  it("accepts a summary of exactly the cap", async () => {
    modelUse.model = answering("y".repeat(MAX_SUMMARY_LENGTH));
    expect(await summarizeTicket(7)).toHaveLength(MAX_SUMMARY_LENGTH);
  });
});
