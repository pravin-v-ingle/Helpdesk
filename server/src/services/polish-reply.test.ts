/**
 * Unit tests for the reply polisher. The first server tests in the repo, so the
 * shape they establish is worth stating:
 *
 * - **`bun test`**, not Vitest. The runtime is Bun and the server has no build
 *   step, so its own runner needs no dependency and no configuration. The client
 *   stays on Vitest, which is what Vite's jsdom setup is built around.
 * - **The test file sits beside the module**, as the client's do.
 * - **Two boundaries are replaced and nothing else**: the ticket read, so no test
 *   touches Postgres, and the model, so no test touches OpenAI. Both live in
 *   `test/fakes.ts`, which explains why every fake these features share is
 *   registered in one place.
 * - **The model is the AI SDK's own `MockLanguageModelV4`**, so `generateText`
 *   runs for real and the assertions below are made against the call the service
 *   actually built - the prompt, the options, the provider options - rather than
 *   against a stubbed `generateText`, which would pin nothing.
 */
import { MAX_REPLY_LENGTH } from "@helpdesk/core/schemas/tickets";
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { MessageDirection } from "../generated/prisma/enums.ts";
import { HttpError } from "../middleware/error-handler.ts";
import {
  answering,
  detail,
  failing,
  getTicket,
  message,
  modelUse,
  type ModelCall,
  openAiModel,
  resetFakes,
  ticketRead,
} from "../test/fakes.ts";

const { polishReply } = await import("./polish-reply.ts");

/** The one call the model was asked to make. Fails the test if there was none. */
function call(): ModelCall {
  const calls = modelUse.model.doGenerateCalls;
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

/** The system message, which is where the editing instructions go. */
function instructions(): string {
  const first = call().prompt[0]!;
  expect(first.role).toBe("system");
  return first.role === "system" ? first.content : "";
}

/** The user message: the ticket as context, then the draft. */
function userPrompt(): string {
  const second = call().prompt[1]!;
  expect(second.role).toBe("user");
  if (second.role !== "user") return "";

  return second.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The thrown `HttpError` as `status` and `message`, for a call that must fail. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    const { status, message: reason } = err as HttpError;
    return { status, message: reason };
  }
  throw new Error("Expected polishReply to throw, but it resolved.");
}

describe("polishReply", () => {
  beforeEach(resetFakes);

  it("returns what the model wrote", async () => {
    expect(await polishReply(7, "fixed ur enrolment")).toBe(
      "Thank you for getting in touch. I have fixed your enrolment.",
    );
  });

  /**
   * Trimmed, because the rewrite goes straight back into a textarea and leading
   * newlines from a model are an edit the agent would otherwise have to make.
   */
  it("trims what the model wrote", async () => {
    modelUse.model = answering("\n\n  A tidy reply.  \n");
    expect(await polishReply(7, "a draft")).toBe("A tidy reply.");
  });

  it("sends the editing instructions as a system message", async () => {
    await polishReply(7, "a draft");

    // The wording is the service's business and gets edited freely; what this
    // pins is that the instructions are there at all and arrive as the system
    // message, rather than being appended to the draft where the model would
    // read them as something the agent wrote.
    expect(instructions().length).toBeGreaterThan(100);
    expect(instructions()).toContain("rewrite");
  });

  /**
   * The draft goes last and is labelled, because that is the instruction a model
   * follows most reliably - and because everything before it is context the model
   * must not start answering.
   */
  it("gives the ticket as context and the draft last", async () => {
    await polishReply(7, "fixed ur enrolment");
    const prompt = userPrompt();

    expect(prompt).toContain("Cannot see my enrolment");
    expect(prompt).toContain("Ada Lovelace");
    expect(prompt).toContain("I cannot see my enrolment.");
    expect(prompt).toContain("The agent's draft reply to rewrite:");
    expect(prompt.trimEnd().endsWith("fixed ur enrolment")).toBe(true);
  });

  /** Who said what, or the model cannot tell the question from the answers. */
  it("labels each message with whether the student or an agent sent it", async () => {
    ticketRead.ticket = detail({
      messages: [
        message({ id: 1, body: "I cannot see my enrolment." }),
        message({
          id: 2,
          direction: MessageDirection.OUTBOUND,
          fromName: "Bob Agent",
          fromEmail: "bob@example.com",
          body: "Looking into it now.",
        }),
      ],
    });

    await polishReply(7, "a draft");
    const prompt = userPrompt();

    expect(prompt).toContain("Student (Ada Lovelace): I cannot see my enrolment.");
    expect(prompt).toContain("Agent (Bob Agent): Looking into it now.");
  });

  /** Latency and cost, not correctness: the tail is what a reply answers. */
  it("sends only the last six messages", async () => {
    ticketRead.ticket = detail({
      messages: Array.from({ length: 9 }, (_, i) =>
        message({ id: i + 1, body: `message number ${i + 1}` }),
      ),
    });

    await polishReply(7, "a draft");
    const prompt = userPrompt();

    expect(prompt).not.toContain("message number 3");
    expect(prompt).toContain("message number 4");
    expect(prompt).toContain("message number 9");
  });

  it("truncates a long message rather than sending all of it", async () => {
    ticketRead.ticket = detail({ messages: [message({ body: "x".repeat(2_500) })] });

    await polishReply(7, "a draft");
    const prompt = userPrompt();

    expect(prompt).toContain(`${"x".repeat(2_000)}…`);
    expect(prompt).not.toContain("x".repeat(2_001));
  });

  /**
   * Not reachable through the inbound path, which creates a ticket and its first
   * message together - but an empty context must say so rather than leaving the
   * model a dangling heading to invent a conversation under.
   */
  it("says so when there are no messages to show", async () => {
    ticketRead.ticket = detail({ messages: [] });

    await polishReply(7, "a draft");
    expect(userPrompt()).toContain("(no messages yet)");
  });

  /**
   * Copy-editing, cheaply, and with nothing left behind: `store: false` is the
   * one of these three that matters beyond the bill, because the prompt carries a
   * student's own words.
   */
  it("asks for a cheap, low-verbosity, unstored completion", async () => {
    await polishReply(7, "a draft");
    const options = call();

    expect(options.maxOutputTokens).toBe(2_000);
    expect(options.providerOptions?.openai).toEqual({
      reasoningEffort: "low",
      textVerbosity: "low",
      store: false,
    });
    // An agent is waiting on a button, so the provider is on a clock.
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("reads the ticket named in the path", async () => {
    await polishReply(42, "a draft");
    expect(getTicket).toHaveBeenCalledWith(42);
  });

  /** No sense paying for a rewrite of a draft on a ticket that does not exist. */
  it("does not call the model when the ticket is gone", async () => {
    ticketRead.error = new HttpError(404, "Ticket not found");

    expect(await refusal(polishReply(7, "a draft"))).toEqual({
      status: 404,
      message: "Ticket not found",
    });
    expect(openAiModel).not.toHaveBeenCalled();
  });

  /**
   * A server with no `OPENAI_API_KEY` already says the right thing, so that
   * refusal passes through rather than being flattened into the generic 502.
   */
  it("passes the unconfigured-server refusal through untouched", async () => {
    modelUse.error = new HttpError(503, "AI features are not configured on this server.");

    expect(await refusal(polishReply(7, "a draft"))).toEqual({
      status: 503,
      message: "AI features are not configured on this server.",
    });
  });

  /**
   * Whatever the provider did wrong, the agent gets one sentence - and the real
   * error is logged rather than returned, because it can carry the request body
   * back, which is a student's message.
   */
  it("turns a provider failure into one 502 and logs the cause", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const cause = new Error("401 Incorrect API key provided: sk-abc123");
    modelUse.model = failing(cause);

    const { status, message: reason } = await refusal(polishReply(7, "a draft"));
    expect(status).toBe(502);
    expect(reason).toBe("Could not polish the reply just now. Please try again.");
    // Nothing of the provider's own error reaches the caller.
    expect(reason).not.toContain("sk-abc123");
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  /**
   * An empty answer is a failure that did not throw. Returning it would wipe the
   * agent's draft, the one outcome this feature must not have.
   */
  it("refuses an empty answer rather than returning it", async () => {
    modelUse.model = answering("   \n  ");

    expect(await refusal(polishReply(7, "a draft"))).toEqual({
      status: 502,
      message: "The model returned an empty reply. Please try again.",
    });
  });

  /**
   * The rewrite goes back into a field the shared schema validates, so one over
   * the limit would be a response the form then refuses with nothing on screen to
   * say why.
   */
  it("refuses a rewrite longer than a reply may be", async () => {
    modelUse.model = answering("y".repeat(MAX_REPLY_LENGTH + 1));

    expect(await refusal(polishReply(7, "a draft"))).toEqual({
      status: 502,
      message: "The polished reply came back too long to use. Please try again.",
    });
  });

  it("accepts a rewrite of exactly the maximum length", async () => {
    modelUse.model = answering("y".repeat(MAX_REPLY_LENGTH));
    expect(await polishReply(7, "a draft")).toHaveLength(MAX_REPLY_LENGTH);
  });
});
