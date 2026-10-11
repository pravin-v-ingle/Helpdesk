/**
 * Unit tests for the knowledge-base auto-resolver.
 *
 * **Most of this file is about what the feature refuses to do**, and that
 * proportion is the point rather than an accident of what was easy to test. This
 * is the only thing in the system that answers a student with nobody in between,
 * so the valuable property is not that it replies well - no unit test can judge
 * that - but that it declines in every case where replying would be wrong. Each
 * `expect(openAiModel).not.toHaveBeenCalled()` below is one of those cases, and
 * each is reachable in production.
 *
 * Three things carry the feature and the file is organised around them:
 *
 * - **Declining is the default.** Coverage decides, and anything the knowledge
 *   base does not answer stays OPEN. The model's `canAnswer: false` is only one
 *   of the ways that happens; the phrase list, the guards and the four
 *   pre-flight refusals are the others.
 * - **The money asymmetry.** A question *about* the refund policy resolves; a
 *   request *for* money does not; and a reply that quotes "money-back
 *   guarantee" must not escalate itself. Those three tests exist because the
 *   obvious implementation - one phrase list checked both ways - gets the third
 *   wrong and silently disables the feature's best case.
 * - **The guarded write.** The model call takes seconds and an agent can act in
 *   them, so the status write decides and the reply must not be stored without
 *   it.
 *
 * Plus the throw-vs-return split the classifier's tests pin for the same reason:
 * a thrown error is how a job earns its retry, and getting it backwards either
 * loses work silently or fills the dead-letter queue.
 *
 * Same seams as the other AI tests, from `test/fakes.ts`.
 */
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { TicketStatus } from "../generated/prisma/enums.ts";
import {
  addressEnv,
  answering,
  autoResolveRow,
  autoResolveTicketRow,
  choosing,
  deciding,
  DEFAULT_AUTO_REPLY,
  DEFAULT_KNOWLEDGE_BASE,
  failing,
  knowledgeBaseUse,
  type ModelCall,
  modelUse,
  openAiModel,
  openaiEnv,
  resetFakes,
  txUse,
} from "../test/fakes.ts";

// `await import`, not a static import: `mock.module` is not hoisted in Bun, so a
// static import of the module under test can be evaluated before `fakes.ts` has
// finished registering - which binds the real Prisma client and talks to the
// developer's own database. See the same note in `classify-ticket.test.ts`.
const { autoResolveTicket } = await import("./auto-resolve-ticket.ts");

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

/** The one `updateMany` the write makes, which is where the race is handled. */
function updateArgs() {
  expect(txUse.updateManys).toHaveLength(1);
  return txUse.updateManys[0]!;
}

/** The one message the write stores. */
function storedMessage() {
  expect(txUse.messages).toHaveLength(1);
  return txUse.messages[0]!;
}

/** Silences one expected log line and hands back the spy to assert on. */
function silence(level: "error" | "warn" | "info") {
  return spyOn(console, level).mockImplementation(() => {});
}

/**
 * Asserts that auto-resolving declined, and that it declined *before paying for
 * a model call*. Every refusal in the service's pre-flight table has this shape,
 * so it is worth one helper rather than four assertions repeated nine times.
 */
async function refusesBeforeTheModel(level: "info" | "warn" = "info") {
  const logged = silence(level);

  expect(await autoResolveTicket(7)).toBeNull();
  expect(openAiModel).not.toHaveBeenCalled();
  expect(txUse.updateManys).toEqual([]);
  expect(txUse.messages).toEqual([]);

  logged.mockRestore();
}

/** Asserts that nothing was written, whether or not the model was asked. */
function wroteNothing() {
  expect(txUse.updateManys).toEqual([]);
  expect(txUse.messages).toEqual([]);
}

/**
 * Asserts that auto-resolving throws, and hands back what it threw. A rejection
 * is the contract, not a failure of it: pg-boss turns it into a retry.
 */
async function rejection(ticketId: number): Promise<unknown> {
  try {
    await autoResolveTicket(ticketId);
  } catch (err) {
    return err;
  }
  throw new Error("Expected autoResolveTicket to throw, but it resolved.");
}

describe("autoResolveTicket", () => {
  beforeEach(() => {
    resetFakes();
    // A configured server with a knowledge base is the premise of every test
    // that expects a model call. Both are checked by the service itself, so that
    // an unconfigured server answers without burning the job's retries.
    openaiEnv.apiKey = "sk-unit-test";
    modelUse.model = deciding({ canAnswer: true, reply: DEFAULT_AUTO_REPLY });
  });

  // --- the happy path ---------------------------------------------------------

  it("replies and resolves a ticket the knowledge base answers", async () => {
    const logged = silence("info");

    expect(await autoResolveTicket(7)).toBe(DEFAULT_AUTO_REPLY);

    expect(updateArgs().data).toEqual({
      status: TicketStatus.RESOLVED,
      autoResolvedAt: expect.any(Date),
      resolvedAt: expect.any(Date),
    });
    // The same instant, from one `new Date()`. Two columns because they answer
    // different questions - when the ticket left the queue, and that the reply
    // was not a colleague's - and they part company the moment a student's
    // reply reopens it, which clears the first and keeps the second.
    const { autoResolvedAt, resolvedAt } = updateArgs().data as {
      autoResolvedAt: Date;
      resolvedAt: Date;
    };
    expect(resolvedAt.getTime()).toBe(autoResolvedAt.getTime());
    expect(storedMessage()).toMatchObject({
      ticketId: 7,
      direction: "OUTBOUND",
      body: DEFAULT_AUTO_REPLY,
    });

    logged.mockRestore();
  });

  /**
   * RESOLVED is as far as a machine goes. Only a human closes a ticket, and a
   * RESOLVED ticket reopens by itself when the student replies - which is what
   * makes it the safe end state. Cheap to assert and exactly the sort of thing
   * someone later "tidies up" into CLOSED.
   */
  it("resolves and never closes", async () => {
    await autoResolveTicket(7);

    expect(updateArgs().data.status).toBe(TicketStatus.RESOLVED);
    expect(updateArgs().data.status).not.toBe(TicketStatus.CLOSED);
  });

  /**
   * The line the whole write exists for. The model call took seconds; an
   * `update` by id would overwrite an agent who resolved, closed or replied in
   * them.
   */
  it("only writes while the ticket is still open and unanswered", async () => {
    await autoResolveTicket(7);

    expect(updateArgs().where).toEqual({
      id: 7,
      status: TicketStatus.OPEN,
      autoResolvedAt: null,
    });
  });

  /**
   * **The orphan-reply bug, which is the worst outcome this feature could
   * have.** If the status write loses the race and the reply is stored anyway,
   * an agent's ticket grows an outbound message from the support team that
   * nobody sent and nothing explains. So the status write goes first and its
   * count decides.
   */
  it("writes no reply when it loses the race to an agent", async () => {
    const logged = silence("info");
    autoResolveRow.updatedCount = 0;

    expect(await autoResolveTicket(7)).toBeNull();
    expect(txUse.updateManys).toHaveLength(1);
    expect(txUse.messages).toEqual([]);
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  // --- the reply says nothing about where it came from ------------------------

  /**
   * The thread is deliberately silent about the automation - no footer, and the
   * support team as the sender - because `Ticket.autoResolvedAt` and the detail
   * page's notice are where an agent learns about it. A disclaimer stapled to the
   * student's answer would be the wrong place to tell the wrong person.
   */
  it("stores the reply with no mention of AI or automation", async () => {
    await autoResolveTicket(7);
    const stored = storedMessage();

    expect(String(stored.body)).not.toMatch(/\bAI\b|automat|bot\b|generated|language model/i);
    expect(String(stored.fromName)).not.toMatch(/\bAI\b|automat|bot\b|assistant/i);
    // The model's text and nothing else: no footer was appended.
    expect(stored.body).toBe(DEFAULT_AUTO_REPLY);
  });

  it("attributes the reply to the support team rather than a person", async () => {
    addressEnv.supportEmailAddress = "support@codewithmosh.example";
    await autoResolveTicket(7);

    expect(storedMessage().fromName).toBe("Code with Mosh Support Team");
    expect(storedMessage().fromEmail).toBe("support@codewithmosh.example");
  });

  /**
   * `SUPPORT_EMAIL_ADDRESS` is optional and commented out in `.env.example`, so
   * an unconfigured server is the normal case rather than an edge one - and
   * `Message.fromEmail` is required, so there has to be something. A visibly
   * local placeholder beats a plausible-looking invented address: nobody reading
   * a thread mistakes `support@localhost` for a mailbox that works.
   */
  it("falls back to a visibly local address when none is configured", async () => {
    addressEnv.supportEmailAddress = undefined;
    await autoResolveTicket(7);

    expect(storedMessage().fromEmail).toBe("support@localhost");
  });

  /** Nothing was emailed, so claiming a Message-ID would claim it was. */
  it("mints no Message-ID, because nothing was sent", async () => {
    await autoResolveTicket(7);

    expect(storedMessage().rfcMessageId).toBeNull();
  });

  // --- the pre-flight refusals, none of which pays for a model call ----------

  it("does nothing when there is no knowledge base", async () => {
    knowledgeBaseUse.text = null;

    // Logged by `lib/knowledge-base.ts` on its first read, not once per ticket,
    // so there is nothing to silence here.
    expect(await autoResolveTicket(7)).toBeNull();
    expect(openAiModel).not.toHaveBeenCalled();
    wroteNothing();
  });

  it("does nothing on a server with no API key", async () => {
    openaiEnv.apiKey = undefined;
    await refusesBeforeTheModel();
  });

  it("does nothing for a ticket that is not there", async () => {
    autoResolveRow.ticket = null;
    await refusesBeforeTheModel("warn");
  });

  it.each([TicketStatus.RESOLVED, TicketStatus.CLOSED])(
    "leaves a %s ticket alone - an agent has dealt with it",
    async (status) => {
      autoResolveRow.ticket = autoResolveTicketRow({ status });
      await refusesBeforeTheModel();
    },
  );

  it("leaves a ticket it has already answered alone", async () => {
    autoResolveRow.ticket = autoResolveTicketRow({
      autoResolvedAt: new Date("2026-09-28T10:00:00.000Z"),
    });
    await refusesBeforeTheModel();
  });

  /**
   * **A thread is not an arrival.** The prompt is built from `Ticket.body`, the
   * *opening* message, so on a conversation that has moved on this would answer
   * the first question as though nothing had been said since. Only enqueued for
   * a new ticket, and checked again here because a reply can land between the
   * enqueue and the worker picking the job up.
   */
  it.each([0, 2, 5])("leaves a ticket with %i messages alone", async (messages) => {
    autoResolveRow.ticket = autoResolveTicketRow({ _count: { messages } });
    await refusesBeforeTheModel();
  });

  it.each(["", "   \n  "])("leaves a ticket with no body to answer alone", async (body) => {
    autoResolveRow.ticket = autoResolveTicketRow({ body });
    await refusesBeforeTheModel();
  });

  // --- section 10, enforced in code ------------------------------------------

  /**
   * One case per escalation category in the knowledge base's section 10. All of
   * them refuse *before* the model, because a ticket that must reach a human is
   * not a ticket worth paying to think about.
   */
  it.each([
    ["legal", "I am going to take legal action over this."],
    ["a lawyer", "My lawyer will be in touch about this course."],
    ["a solicitor", "I have spoken to my solicitor."],
    ["court", "I will see you in court."],
    ["a chargeback", "I am filing a chargeback with my bank."],
    ["a dispute", "I want to dispute the charge on my card."],
    ["fraud", "This looks like fraud to me."],
    ["a double charge", "I was charged twice for the same course."],
    ["a hacked account", "I think my account has been hacked."],
    ["a compromise", "My account may be compromised."],
    ["unauthorised access", "There has been unauthorised access to my account."],
    ["a breach", "Was there a security breach?"],
    ["a refund request", "I want a refund for the course I bought last week."],
    ["another refund request", "Please refund me for this course."],
    ["money back", "I would like my money back."],
  ])("escalates a ticket mentioning %s", async (_label, body) => {
    autoResolveRow.ticket = autoResolveTicketRow({ body });
    await refusesBeforeTheModel();
  });

  it("escalates on the subject as well as the body", async () => {
    autoResolveRow.ticket = autoResolveTicketRow({
      subject: "Chargeback",
      body: "The videos will not play for me.",
    });
    await refusesBeforeTheModel();
  });

  /**
   * **Word boundaries, not substrings**, and this is why. `sue` is inside
   * `issue`, and `issue` is inside most technical tickets - so a bare
   * `String.includes` would escalate nearly every section 7 question the
   * knowledge base answers best, and the feature would look broken rather than
   * over-cautious.
   */
  it.each([
    "I have an issue with video playback.",
    "Please pursue this with the video team.",
    "The support staff were very courteous but the video still fails.",
  ])("does not escalate %p on a substring", async (body) => {
    autoResolveRow.ticket = autoResolveTicketRow({ body });

    expect(await autoResolveTicket(7)).toBe(DEFAULT_AUTO_REPLY);
  });

  // --- the money asymmetry, which is the subtlest thing here ------------------

  /**
   * A *question about* the refund policy is answerable from section 4, and
   * answering it promises nobody anything - so it resolves. This is the case the
   * rejected "money always escalates" rule would have thrown away, and the
   * reason the incoming list names money *requests* rather than the word
   * `refund`.
   */
  it("answers a question about the refund policy", async () => {
    autoResolveRow.ticket = autoResolveTicketRow({
      subject: "Refund policy",
      body: "What is your refund policy?",
    });

    expect(await autoResolveTicket(7)).toBe(DEFAULT_AUTO_REPLY);
    expect(updateArgs().data.status).toBe(TicketStatus.RESOLVED);
  });

  it("answers a question about how to request a refund", async () => {
    autoResolveRow.ticket = autoResolveTicketRow({
      body: "How do I request a refund if I need one?",
    });

    expect(await autoResolveTicket(7)).toBe(DEFAULT_AUTO_REPLY);
  });

  /**
   * The other half: a request *for* money escalates, because this system knows
   * neither the purchase date nor how much of the course was watched, so it
   * cannot establish that the request is inside the 30-day window - and section
   * 10 says to escalate when it is outside. Unable to tell is not inside.
   */
  it("escalates a request for money even though section 4 exists", async () => {
    autoResolveRow.ticket = autoResolveTicketRow({
      subject: "Refund",
      body: "I want a refund for the course I bought.",
    });
    await refusesBeforeTheModel();
  });

  /**
   * **The trap the two lists exist to avoid.** The correct section 4 answer
   * contains the phrase "money-back guarantee". Checking the money phrases
   * against the *reply* would self-escalate exactly the answer this feature is
   * best at, and the symptom would read as a prompt problem rather than a list
   * problem.
   */
  it("does not escalate its own reply for quoting the money-back guarantee", async () => {
    const reply =
      "We offer a 30-day money-back guarantee, and a full refund if you ask within 30 days of purchase. Support team";
    modelUse.model = deciding({ canAnswer: true, reply });
    autoResolveRow.ticket = autoResolveTicketRow({ body: "What is your refund policy?" });

    expect(await autoResolveTicket(7)).toBe(reply);
    expect(storedMessage().body).toBe(reply);
  });

  /**
   * The reply list is narrower but not empty: if the model raises lawyers,
   * chargebacks or a compromised account by itself, the ticket belongs to a
   * person however confident the answer sounded.
   */
  it.each([
    "You should speak to a lawyer about this matter, and we will wait to hear. Support team",
    "Your account may have been compromised, so we have locked it for now. Support team",
    "Please raise a chargeback with your bank if you would prefer that route. Support team",
  ])("leaves the ticket open when its own reply raises %p", async (reply) => {
    const logged = silence("info");
    modelUse.model = deciding({ canAnswer: true, reply });

    expect(await autoResolveTicket(7)).toBeNull();
    wroteNothing();
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  // --- the guards on the answer ----------------------------------------------

  it("leaves the ticket open when the model declines", async () => {
    const logged = silence("info");
    modelUse.model = deciding({ canAnswer: false, reply: "" });

    expect(await autoResolveTicket(7)).toBeNull();
    wroteNothing();
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
  });

  /**
   * Decided to answer and then said almost nothing. An acknowledgement on a
   * ticket that is about to leave the queue is worse than no reply at all,
   * because the ticket stops being anybody's job.
   */
  it("leaves the ticket open when the reply is too short to be one", async () => {
    const logged = silence("info");
    modelUse.model = deciding({ canAnswer: true, reply: "Thanks, we will look into it." });

    expect(await autoResolveTicket(7)).toBeNull();
    wroteNothing();

    logged.mockRestore();
  });

  it("leaves the ticket open when whitespace is all there is", async () => {
    const logged = silence("info");
    modelUse.model = deciding({ canAnswer: true, reply: "   \n\n   " });

    expect(await autoResolveTicket(7)).toBeNull();
    wroteNothing();

    logged.mockRestore();
  });

  /**
   * The ceiling is `MAX_REPLY_LENGTH` from `@helpdesk/core`, the same number the
   * composer and `POST /api/tickets/:id/messages` enforce - imported rather than
   * restated, so a stored reply is always one an agent could have typed.
   */
  it("leaves the ticket open when the reply is longer than a reply may be", async () => {
    const logged = silence("info");
    modelUse.model = deciding({ canAnswer: true, reply: "x".repeat(10_001) });

    expect(await autoResolveTicket(7)).toBeNull();
    wroteNothing();

    logged.mockRestore();
  });

  it("accepts a reply exactly at the limit", async () => {
    const reply = "x".repeat(10_000);
    modelUse.model = deciding({ canAnswer: true, reply });

    expect(await autoResolveTicket(7)).toBe(reply);
  });

  // --- what the model is asked ------------------------------------------------

  it("sends the whole knowledge base, fenced, with the ticket after it", async () => {
    await autoResolveTicket(7);
    const prompt = userPrompt();

    expect(prompt).toContain(DEFAULT_KNOWLEDGE_BASE);
    expect(prompt).toContain("--- BEGIN KNOWLEDGE BASE ---");
    expect(prompt).toContain("--- END KNOWLEDGE BASE ---");
    expect(prompt).toContain("Subject: Videos are not playing");
    expect(prompt).toContain("the lesson videos will not play");
    // The document comes before the ticket, so the ticket is what the model is
    // reading the document for rather than the other way round.
    expect(prompt.indexOf("--- END KNOWLEDGE BASE ---")).toBeLessThan(
      prompt.indexOf("Subject: Videos are not playing"),
    );
  });

  it("truncates a very long opening message", async () => {
    autoResolveRow.ticket = autoResolveTicketRow({ body: "x".repeat(4_500) });

    await autoResolveTicket(7);
    const prompt = userPrompt();

    expect(prompt).toContain(`${"x".repeat(4_000)}…`);
    expect(prompt).not.toContain("x".repeat(4_001));
  });

  /** Declining has to be the cheap answer, and the instructions have to say so. */
  it("tells the model that declining is the safe choice and what answering costs", async () => {
    await autoResolveTicket(7);

    expect(instructions()).toContain("No human reads it first");
    expect(instructions()).toContain("choose false");
  });

  /** Section 10 carried as hard rules, not left to the phrase list alone. */
  it("carries the escalation rules into the instructions", async () => {
    await autoResolveTicket(7);
    const text = instructions();

    expect(text).toContain("threatens legal action");
    expect(text).toContain("outside the 30-day window");
    expect(text).toContain("disputes a charge");
    expect(text).toContain("account security");
    expect(text).toContain("confidence is low");
  });

  it("forbids inventing facts, addressing AI, and telling the student to contact support", async () => {
    await autoResolveTicket(7);
    const text = instructions();

    expect(text).toContain("Do not invent anything");
    expect(text).toContain("Say nothing about AI");
    expect(text).toContain("Do not tell the student to contact support");
  });

  /**
   * The answer's shape is enforced by the response schema rather than parsed, as
   * the classifier's is - and strictly, which is why neither field may be
   * optional. An answer of the wrong shape throws inside the SDK and earns the
   * job a retry.
   */
  it("constrains the answer with a strict two-field response schema", async () => {
    await autoResolveTicket(7);

    const format = call().responseFormat;
    expect(format?.type).toBe("json");
    const schema = format?.type === "json" ? (format.schema as Record<string, unknown>) : undefined;

    expect(Object.keys(schema?.properties as object)).toEqual(["canAnswer", "reply"]);
    expect(schema?.required).toEqual(["canAnswer", "reply"]);
    expect(schema?.additionalProperties).toBe(false);
  });

  /**
   * `reasoningEffort: "medium"`, against the other three features' `"low"`. This
   * call decides whether a ticket leaves the queue, and that is exactly the
   * judgement cheap reasoning gets wrong expensively.
   */
  it("pays for medium reasoning and stores nothing", async () => {
    await autoResolveTicket(7);
    const options = call();

    expect(options.maxOutputTokens).toBe(4_000);
    expect(options.providerOptions?.openai).toEqual({
      reasoningEffort: "medium",
      textVerbosity: "low",
      store: false,
    });
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  // --- transient failures, which must throw so the job is retried ------------

  it("throws when the provider fails, so the job is retried", async () => {
    modelUse.model = failing(new Error("429 Rate limit reached"));

    await rejection(7);
    wroteNothing();
  });

  /**
   * The response schema refuses a malformed answer inside the SDK. Worth a
   * retry: the next attempt may well come back well-formed, and the ticket stays
   * open in the meantime rather than getting an invented reply.
   */
  it("throws on an answer that does not match the schema", async () => {
    modelUse.model = answering(JSON.stringify({ canAnswer: "yes" }));

    await rejection(7);
    wroteNothing();
  });

  it("throws on an answer that is not JSON at all", async () => {
    modelUse.model = answering("I think the knowledge base covers this one.");

    await rejection(7);
    wroteNothing();
  });

  /**
   * `Output.choice`'s wire shape, which this one must *not* accept. A guard
   * against the two helpers in `test/fakes.ts` being confused for each other,
   * and against anyone "fixing" the schema to match the classifier's.
   */
  it("throws on the choice-style wrapper the classifier uses", async () => {
    modelUse.model = choosing("true");

    await rejection(7);
    wroteNothing();
  });

  it("throws when the ticket cannot be read", async () => {
    autoResolveRow.findError = new Error("connection terminated");

    await rejection(7);
    expect(openAiModel).not.toHaveBeenCalled();
  });

  /**
   * The model has been paid for by this point, so the retry pays again - but a
   * reply that was written and then lost to a deadlock is worth the second call,
   * and the guarded `updateMany` makes the retry safe: if the first attempt did
   * commit after all, the second finds the ticket resolved and writes nothing.
   */
  it("throws when the resolution cannot be written", async () => {
    autoResolveRow.updateError = new Error("deadlock detected");

    await rejection(7);
    expect(txUse.messages).toEqual([]);
  });

  it("throws when the transaction itself fails", async () => {
    autoResolveRow.transactionError = new Error("could not serialize access");

    await rejection(7);
    wroteNothing();
  });
});
