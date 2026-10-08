/**
 * Unit tests for the automatic classifier.
 *
 * Two properties carry this feature and most of the file is about them:
 *
 * - **It never throws.** It is called with a bare `void` from the inbound path, so
 *   a rejection has nobody to catch it. Every failure below asserts a `null`
 *   return rather than a thrown error, which is the only reason that call site is
 *   safe.
 * - **It never overwrites a human.** The write is conditional on the category
 *   still being null, because an agent can classify a brand-new ticket inside the
 *   second the model takes.
 *
 * Same seams as the other AI tests, from `test/ai-fakes.ts`, plus the Prisma calls
 * this service makes directly.
 */
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { TicketCategory } from "../generated/prisma/enums.ts";
import { HttpError } from "../middleware/error-handler.ts";
import {
  answering,
  choosing,
  classifyRow,
  failing,
  type ModelCall,
  modelUse,
  openAiModel,
  resetFakes,
  ticketFindUnique,
  ticketUpdateMany,
} from "../test/ai-fakes.ts";

// `await import`, not a static import: `mock.module` is not hoisted in Bun, and a
// static import of the module under test can be evaluated before `ai-fakes` has
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

describe("classifyTicket", () => {
  beforeEach(() => {
    resetFakes();
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

  // --- the failures, none of which may throw ---------------------------------

  it("swallows a provider failure", async () => {
    const logged = silence("error");
    modelUse.model = failing(new Error("429 Rate limit reached"));

    expect(await classifyTicket(7)).toBeNull();
    expect(ticketUpdateMany).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  /**
   * A server with no `OPENAI_API_KEY` is not an error so much as a server that
   * does not do this - and it is the state the e2e stack runs in deliberately.
   */
  it("swallows the unconfigured-server refusal", async () => {
    const logged = silence("error");
    modelUse.error = new HttpError(503, "AI features are not configured on this server.");

    expect(await classifyTicket(7)).toBeNull();
    expect(ticketUpdateMany).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  /**
   * The schema refuses an off-list answer inside the SDK, which arrives here as a
   * thrown error - so the ticket keeps no category rather than an invented one.
   */
  it("swallows an answer outside the category list", async () => {
    const logged = silence("error");
    modelUse.model = choosing("BILLING_DISPUTE");

    expect(await classifyTicket(7)).toBeNull();
    expect(ticketUpdateMany).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  it("swallows an answer that is not a choice at all", async () => {
    const logged = silence("error");
    modelUse.model = answering("I think this one is technical.");

    expect(await classifyTicket(7)).toBeNull();
    expect(ticketUpdateMany).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  it("swallows a failed read", async () => {
    const logged = silence("error");
    classifyRow.findError = new Error("connection terminated");

    expect(await classifyTicket(7)).toBeNull();
    expect(openAiModel).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  it("swallows a failed write", async () => {
    const logged = silence("error");
    classifyRow.updateError = new Error("deadlock detected");

    expect(await classifyTicket(7)).toBeNull();
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });
});
