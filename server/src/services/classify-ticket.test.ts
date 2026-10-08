/**
 * Unit tests for the automatic classifier.
 *
 * Two properties carry this feature and most of the file is about them:
 *
 * - **It throws exactly when a retry would help.** The job runs in a pg-boss
 *   worker, so a thrown error is how the job earns its three retries - and a
 *   swallowed one is a classification silently lost. The split the tests below
 *   pin: a provider failure, a timeout or an unparseable answer throws; a missing
 *   ticket, an already-classified ticket, a lost race or an unconfigured server
 *   returns `null`, because retrying any of those just fills the dead-letter
 *   queue. This is the reverse of what this file asserted before the queue
 *   existed, when the caller was a bare `void` that could not catch anything.
 * - **It never overwrites a human.** The write is conditional on the category
 *   still being null, because an agent can classify a brand-new ticket before the
 *   worker picks the job up.
 *
 * Same seams as the other AI tests, from `test/fakes.ts`, plus the Prisma calls
 * this service makes directly.
 */
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { TicketCategory } from "../generated/prisma/enums.ts";
import {
  answering,
  choosing,
  classifyRow,
  failing,
  type ModelCall,
  modelUse,
  openAiModel,
  openaiEnv,
  resetFakes,
  ticketFindUnique,
  ticketUpdateMany,
} from "../test/fakes.ts";

// `await import`, not a static import: `mock.module` is not hoisted in Bun, and a
// static import of the module under test can be evaluated before `fakes.ts` has
// finished registering its fakes - which binds the real Prisma client and makes
// every test here talk to the developer's database. The dynamic form cannot run
// until the import above has fully evaluated.
const { classifyTicket } = await import("./classify-ticket.ts");

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

/** The `where` of the one `updateMany`, which is where the race is handled. */
function updateArgs() {
  expect(ticketUpdateMany).toHaveBeenCalledTimes(1);
  return ticketUpdateMany.mock.calls[0]![0] as {
    where: { id: number; category: null };
    data: { category: TicketCategory };
  };
}

/** Silences one expected log line and hands back the spy to assert on. */
function silence(level: "error" | "warn" | "info") {
  return spyOn(console, level).mockImplementation(() => {});
}

/**
 * Asserts that classifying throws, and hands back what it threw. A rejection is
 * the contract here, not a failure of it: pg-boss turns it into a retry.
 */
async function rejection(ticketId: number): Promise<unknown> {
  try {
    await classifyTicket(ticketId);
  } catch (err) {
    return err;
  }
  throw new Error("Expected classifyTicket to throw, but it resolved.");
}

describe("classifyTicket", () => {
  beforeEach(() => {
    resetFakes();
    // A configured server is the premise of every test that expects a model call:
    // the service checks `env.openai.apiKey` itself now, so that it can answer an
    // unconfigured server without burning the job's retries.
    openaiEnv.apiKey = "sk-unit-test";
    modelUse.model = choosing(TicketCategory.TECHNICAL_QUESTION);
  });

  it("stores the category the model chose", async () => {
    expect(await classifyTicket(7)).toBe(TicketCategory.TECHNICAL_QUESTION);

    expect(updateArgs().data).toEqual({ category: TicketCategory.TECHNICAL_QUESTION });
    expect(ticketFindUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { subject: true, body: true, category: true },
    });
  });

  it.each([
    TicketCategory.GENERAL_QUESTION,
    TicketCategory.TECHNICAL_QUESTION,
    TicketCategory.REFUND_REQUEST,
  ])("stores %p when that is the answer", async (category) => {
    modelUse.model = choosing(category);
    expect(await classifyTicket(7)).toBe(category);
    expect(updateArgs().data).toEqual({ category });
  });

  /**
   * The line this whole file exists for. An `update` by id would have overwritten
   * an agent who classified the ticket while the model was thinking; matching on
   * `category: null` means the human's answer stands.
   */
  it("only writes while the category is still unset", async () => {
    await classifyTicket(7);
    expect(updateArgs().where).toEqual({ id: 7, category: null });
  });

  it("leaves the agent's category alone when they got there first", async () => {
    const logged = silence("info");
    classifyRow.updatedCount = 0;

    expect(await classifyTicket(7)).toBeNull();
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  /**
   * Reachable precisely because this runs unawaited, and worth catching before the
   * model is paid for rather than after.
   */
  it("does not ask the model about a ticket that is already categorised", async () => {
    classifyRow.ticket = {
      subject: "Cannot see my enrolment",
      body: "I cannot see my enrolment.",
      category: TicketCategory.GENERAL_QUESTION,
    };

    expect(await classifyTicket(7)).toBeNull();
    expect(openAiModel).not.toHaveBeenCalled();
    expect(ticketUpdateMany).not.toHaveBeenCalled();
  });

  it("does nothing for a ticket that is not there", async () => {
    const logged = silence("warn");
    classifyRow.ticket = null;

    expect(await classifyTicket(7)).toBeNull();
    expect(openAiModel).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  it("sends the subject and the opening message", async () => {
    classifyRow.ticket = {
      subject: "Refund for the Python course",
      body: "I would like my money back please.",
      category: null,
    };

    await classifyTicket(7);
    const prompt = userPrompt();

    expect(prompt).toContain("Subject: Refund for the Python course");
    expect(prompt).toContain("I would like my money back please.");
  });

  it("truncates a very long opening message", async () => {
    classifyRow.ticket = { subject: "Help", body: "x".repeat(4_500), category: null };

    await classifyTicket(7);
    const prompt = userPrompt();

    expect(prompt).toContain(`${"x".repeat(4_000)}…`);
    expect(prompt).not.toContain("x".repeat(4_001));
  });

  /** The categories, and what belongs in each, come from one `Record`. */
  it("tells the model what each category means", async () => {
    await classifyTicket(7);

    for (const category of Object.values(TicketCategory)) {
      expect(instructions()).toContain(category);
    }
    expect(instructions()).toContain("refund");
  });

  /**
   * Task 5.3: the schema restricts the answer, rather than the answer being parsed
   * and checked afterwards. An invalid category is not something the provider can
   * return, which is what `Output.choice` buys.
   */
  it("restricts the answer to the three categories in the response schema", async () => {
    await classifyTicket(7);

    const format = call().responseFormat;
    expect(format?.type).toBe("json");
    const schema = format?.type === "json" ? (format.schema as Record<string, unknown>) : undefined;
    const properties = schema?.properties as { result?: { enum?: string[] } } | undefined;

    expect(properties?.result?.enum).toEqual([
      TicketCategory.GENERAL_QUESTION,
      TicketCategory.TECHNICAL_QUESTION,
      TicketCategory.REFUND_REQUEST,
    ]);
  });

  it("asks for a cheap, unstored completion on a shorter clock", async () => {
    await classifyTicket(7);
    const options = call();

    expect(options.maxOutputTokens).toBe(2_000);
    expect(options.providerOptions?.openai).toEqual({
      reasoningEffort: "low",
      textVerbosity: "low",
      store: false,
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  // --- transient failures, which must throw so the job is retried ------------

  it("throws when the provider fails, so the job is retried", async () => {
    const cause = new Error("429 Rate limit reached");
    modelUse.model = failing(cause);

    // The error reaches pg-boss rather than being logged and forgotten - a rate
    // limit half a minute ago is the single most retryable thing here.
    await rejection(7);
    expect(ticketUpdateMany).not.toHaveBeenCalled();
  });

  /**
   * The response schema refuses an off-list answer inside the SDK. Worth a retry:
   * the next attempt may well come back with one of the three, and the ticket
   * keeps no category in the meantime rather than an invented one.
   */
  it("throws on an answer outside the category list", async () => {
    modelUse.model = choosing("BILLING_DISPUTE");

    await rejection(7);
    expect(ticketUpdateMany).not.toHaveBeenCalled();
  });

  it("throws on an answer that is not a choice at all", async () => {
    modelUse.model = answering("I think this one is technical.");

    await rejection(7);
    expect(ticketUpdateMany).not.toHaveBeenCalled();
  });

  it("throws when the ticket cannot be read", async () => {
    classifyRow.findError = new Error("connection terminated");

    await rejection(7);
    expect(openAiModel).not.toHaveBeenCalled();
  });

  /**
   * The model has already been paid for by this point, so a retry pays again -
   * but a category that was decided and then lost to a deadlock is worth the
   * second call, and the conditional write makes the retry safe.
   */
  it("throws when the category cannot be written", async () => {
    classifyRow.updateError = new Error("deadlock detected");

    await rejection(7);
  });

  // --- permanent outcomes, which must not throw ------------------------------

  /**
   * A server with no `OPENAI_API_KEY` does not do this at all - the state the e2e
   * stack runs in deliberately. Three retries and a dead-letter row would claim
   * something is broken when nothing is, so it is answered rather than thrown,
   * and before the model is reached.
   */
  it("does nothing on a server with no API key", async () => {
    const logged = silence("info");
    openaiEnv.apiKey = undefined;

    expect(await classifyTicket(7)).toBeNull();
    expect(openAiModel).not.toHaveBeenCalled();
    expect(ticketUpdateMany).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });
});
