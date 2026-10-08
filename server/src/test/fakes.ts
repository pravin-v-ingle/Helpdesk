/**
 * **The one place every server test registers a module fake.**
 *
 * Not "the AI fakes" any more, though that is still most of what is here. The name
 * is deliberately broad because the rule below admits no second registry: the AI
 * features reach the model and the ticket read, the queue wrapper reaches pg-boss,
 * and both read `env` - so all of it is registered here, once, in one order.
 *
 * That rule has now been learned twice. A `queue.test.ts` that registered its own
 * `env` fake took the `env` fake away from the classifier's tests and broke
 * twenty-eight of them, in a different file, with nothing pointing at the cause.
 *
 * **Why one module rather than a few lines in each test file.** `mock.module` is
 * process-global and `bun test` runs every file in one process with one module
 * registry, so whichever test file happens to load a module first is the one
 * whose fakes it binds to - and Bun has no per-file isolation flag. Two files
 * each registering their own fake for the same module is therefore a test that
 * passes alone and fails in the suite, which is exactly what happened before
 * this module existed. Registering every fake here, once, and importing this
 * module **first** from each test file removes the race: the order below is the
 * only order there is.
 *
 * It also means the two orderings that matter are stated in one place:
 *
 * 1. `env.ts` is replaced before anything reads it, so `lib/ai.ts` can be asked
 *    about a configured key and an unconfigured one in the same run.
 * 2. The real `openAiModel` is captured before `lib/ai.ts` is replaced, so
 *    `ai.test.ts` can test the real thing while everything downstream gets the
 *    fake.
 *
 * Nothing here is reset automatically - call `resetFakes()` in a `beforeEach`.
 * These tests must stay serial: `bun test --concurrent` would let two files
 * drive the same fakes at once.
 */
import "./env-defaults.ts";

import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { mock } from "bun:test";
import type { RequestHandler } from "express";
import { MessageDirection, TicketStatus, type TicketCategory } from "../generated/prisma/enums.ts";
import type { PublicMessage, PublicTicketDetail } from "../services/tickets.ts";

// --- 1. the environment, made movable ---------------------------------------

const realEnvModule = await import("../env.ts");

/**
 * The `env.openai` section, mutable so a test can say whether this server has a
 * key. Everything else about `env` keeps its real value - the fake is a spread of
 * the real module - so nothing that happens to read `env` is disturbed by the
 * substitution.
 */
export const openaiEnv = {
  apiKey: undefined as string | undefined,
  model: "gpt-5-nano",
};

/** The `env.queue` section, mutable so a test can switch the queue off. */
export const queueEnv = {
  enabled: true,
  runWorkers: true,
  schema: "pgboss",
};

// One registration covering both sections, which is the whole point of this
// module: two `mock.module("../env.ts")` calls in two test files means whichever
// loads second is silently ignored.
mock.module("../env.ts", () => ({
  ...realEnvModule,
  env: { ...realEnvModule.env, openai: openaiEnv, queue: queueEnv },
}));

// --- 2. the real wrapper, before it is replaced ------------------------------

/**
 * `lib/ai.ts`'s own export, captured while the registry still holds the real
 * module. `ai.test.ts` tests this; everything else gets the fake registered
 * below.
 */
export const realOpenAiModel = (await import("../lib/ai.ts")).openAiModel;

// --- 3. the model ------------------------------------------------------------

/** One recorded call to a model, as the SDK types it. */
export type ModelCall = LanguageModelV4CallOptions;

/**
 * A model that answers with `text` and records the call it was given.
 *
 * The return type is annotated rather than inferred on purpose. Bun does not
 * typecheck a test run, so a fake that has drifted from the provider interface
 * would otherwise pass here and only be caught - confusingly - the next time
 * `generateText` was given a real model. Saying the type out loud makes the
 * drift a compile error in this file, where it belongs. `@ai-sdk/provider` is a
 * declared devDependency for this reason: it is a transitive package of `ai`,
 * and Bun's isolated `node_modules` does not make those resolvable (see
 * CLAUDE.md), so the types it defines are unusable until we ask for it.
 */
export function answering(text: string) {
  return new MockLanguageModelV4({
    modelId: "gpt-5-nano",
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> => ({
      content: [{ type: "text", text }],
      // An object, not the string it was in earlier versions of the spec: a
      // provider's own wording is kept beside the unified reason.
      finishReason: { unified: "stop", raw: undefined },
      // Nothing under test reads these; they are here because the interface
      // requires them, and the breakdown is per-kind in v4 rather than a flat
      // count.
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 50, text: 50, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

/** A model whose call rejects, standing in for any provider failure. */
export function failing(error: unknown) {
  return new MockLanguageModelV4({
    modelId: "gpt-5-nano",
    doGenerate: async () => {
      throw error;
    },
  });
}

export const DEFAULT_POLISHED = "Thank you for getting in touch. I have fixed your enrolment.";

export const DEFAULT_SUMMARY =
  "Ada cannot see her enrolment. Nothing has been done yet. Someone needs to check her record.";

/**
 * A model that picks `category`, in the shape `Output.choice` actually expects: a
 * JSON object under the key `result`, validated against an `enum` of the options.
 * Worth having as a helper rather than inline, because the key is the AI SDK's
 * private business and a bare `"REFUND_REQUEST"` is a parse failure, not a choice.
 */
export function choosing(category: string) {
  return answering(JSON.stringify({ result: category }));
}

/**
 * What `openAiModel()` hands back, or throws. The AI SDK's own mock model,
 * so `generateText` runs for real and a test can assert against the call it
 * actually built rather than against a stubbed-out `generateText`, which would
 * pin nothing.
 */
export const modelUse = {
  model: answering(DEFAULT_POLISHED),
  error: undefined as unknown,
};

export const openAiModel = mock(() => {
  if (modelUse.error) throw modelUse.error;
  return modelUse.model;
});

mock.module("../lib/ai.ts", () => ({ openAiModel }));

// --- 4. the ticket read ------------------------------------------------------

export function message(overrides: Partial<PublicMessage> = {}): PublicMessage {
  return {
    id: 10,
    direction: MessageDirection.INBOUND,
    fromEmail: "ada@example.com",
    fromName: "Ada Lovelace",
    body: "I cannot see my enrolment.",
    createdAt: new Date("2026-09-28T09:00:00.000Z"),
    ...overrides,
  };
}

export function detail(overrides: Partial<PublicTicketDetail> = {}): PublicTicketDetail {
  const messages = overrides.messages ?? [message()];
  return {
    id: 7,
    subject: "Cannot see my enrolment",
    status: TicketStatus.OPEN,
    category: null,
    requesterEmail: "ada@example.com",
    requesterName: "Ada Lovelace",
    lastMessageAt: new Date("2026-09-28T09:00:00.000Z"),
    createdAt: new Date("2026-09-28T09:00:00.000Z"),
    updatedAt: new Date("2026-09-28T09:00:00.000Z"),
    assignedTo: null,
    ...overrides,
    messages,
    messageCount: messages.length,
  };
}

/** What `getTicket` answers with, or throws. */
export const ticketRead = {
  ticket: detail(),
  error: undefined as unknown,
};

export const getTicket = mock(async (_id: number): Promise<PublicTicketDetail> => {
  if (ticketRead.error) throw ticketRead.error;
  return ticketRead.ticket;
});

/**
 * The whole tickets service, because `routes/tickets.ts` imports all of it and
 * the real module would pull Prisma into the process. The three stubs belong to
 * handlers these tests do not exercise.
 */
mock.module("../services/tickets.ts", () => ({
  getTicket,
  listTickets: mock(),
  updateTicket: mock(),
  addReply: mock(),
}));

// --- 4b. the database, for the classifier ------------------------------------

/**
 * The classifier goes to Prisma directly rather than through the tickets service
 * - it reads two columns and writes one - so it needs its own seam. Only the two
 * calls it makes are faked; nothing else in the suite touches the real client,
 * because `services/tickets.ts` above is replaced wholesale.
 */
export const classifyRow = {
  /** What `findUnique` answers with. `null` is a ticket that is not there. */
  ticket: { subject: "Cannot see my enrolment", body: "I cannot see my enrolment.", category: null } as
    | { subject: string; body: string; category: TicketCategory | null }
    | null,
  /** What `updateMany` reports. `0` means somebody classified it first. */
  updatedCount: 1,
  findError: undefined as unknown,
  updateError: undefined as unknown,
};

export const ticketFindUnique = mock(async (_args: unknown) => {
  if (classifyRow.findError) throw classifyRow.findError;
  return classifyRow.ticket;
});

export const ticketUpdateMany = mock(async (_args: unknown) => {
  if (classifyRow.updateError) throw classifyRow.updateError;
  return { count: classifyRow.updatedCount };
});

mock.module("../lib/prisma.ts", () => ({
  prisma: { ticket: { findUnique: ticketFindUnique, updateMany: ticketUpdateMany } },
}));

// --- 4c. pg-boss, for the queue wrapper --------------------------------------

/** One `send` the fake pg-boss recorded, so its `db` option can be inspected. */
export type SendCall = { name: string; data: unknown; options: { db?: unknown } | undefined };

export type BossHandler = (jobs: { id: string; data: unknown }[]) => Promise<void>;

/**
 * What the fake pg-boss did, and what it should do next. A real instance would
 * want a running Postgres, which a unit test must not have.
 */
export const bossUse = {
  sends: [] as SendCall[],
  created: [] as string[],
  works: [] as { name: string; options: Record<string, unknown>; handler: BossHandler }[],
  startError: undefined as unknown,
  stopError: undefined as unknown,
};

export const boss = {
  on: mock(() => {}),
  start: mock(async () => {
    if (bossUse.startError) throw bossUse.startError;
  }),
  createQueue: mock(async (name: string, _options?: unknown) => {
    bossUse.created.push(name);
  }),
  send: mock(async (name: string, data: unknown, options?: { db?: unknown }) => {
    bossUse.sends.push({ name, data, options });
    return "job-id";
  }),
  stop: mock(async (_options?: unknown) => {
    if (bossUse.stopError) throw bossUse.stopError;
  }),
  work: mock(async (name: string, options: Record<string, unknown>, handler: BossHandler) => {
    bossUse.works.push({ name, options, handler });
    return "worker-id";
  }),
};

/**
 * Stands in for the executor pg-boss builds from a Prisma transaction. What the
 * tests assert is that *something derived from the transaction* reaches `send`,
 * not what shape it has - that part is pg-boss's own business.
 */
export const PRISMA_EXECUTOR = { __fromPrisma: true };

export const fromPrisma = mock((_tx: unknown) => PRISMA_EXECUTOR);

mock.module("pg-boss", () => ({
  PgBoss: class {
    constructor(public options: unknown) {
      Object.assign(this, boss);
    }
  },
  fromPrisma,
}));

// --- 5. the session ----------------------------------------------------------

/**
 * A pass-through. The polish handler reads nothing off the session - no message
 * is written, so there is no author to record - so being let past is the whole of
 * what `requireAuth` contributes to these tests. Whether it is actually *mounted*
 * is a question for a request with a real session, which these are not.
 */
const requireAuth: RequestHandler = (_req, _res, next) => next();
mock.module("../middleware/require-auth.ts", () => ({ requireAuth }));

// --- resetting ---------------------------------------------------------------

export function resetFakes() {
  openaiEnv.apiKey = undefined;
  openaiEnv.model = "gpt-5-nano";

  modelUse.model = answering(DEFAULT_POLISHED);
  modelUse.error = undefined;
  openAiModel.mockClear();

  ticketRead.ticket = detail();
  ticketRead.error = undefined;
  getTicket.mockClear();

  classifyRow.ticket = {
    subject: "Cannot see my enrolment",
    body: "I cannot see my enrolment.",
    category: null,
  };
  classifyRow.updatedCount = 1;
  classifyRow.findError = undefined;
  classifyRow.updateError = undefined;
  ticketFindUnique.mockClear();
  ticketUpdateMany.mockClear();

  queueEnv.enabled = true;
  queueEnv.runWorkers = true;
  bossUse.sends.length = 0;
  bossUse.created.length = 0;
  bossUse.works.length = 0;
  bossUse.startError = undefined;
  bossUse.stopError = undefined;
  fromPrisma.mockClear();
  boss.send.mockClear();
  boss.createQueue.mockClear();
  boss.stop.mockClear();
  boss.work.mockClear();
}
