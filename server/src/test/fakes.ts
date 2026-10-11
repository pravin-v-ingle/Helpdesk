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

/**
 * `env.supportEmailAddress`, made movable for the same reason.
 *
 * It has to be fake-controlled rather than spread through from the real module,
 * because it is read from `SUPPORT_EMAIL_ADDRESS` - which `test/env-defaults.ts`
 * deliberately does not set, so a developer with one in `server/.env` and a CI
 * box without one would run different tests. The auto-resolver's reply is
 * attributed to this address and falls back when it is absent, and both branches
 * are worth pinning.
 */
export const addressEnv = {
  supportEmailAddress: undefined as string | undefined,
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
  env: {
    ...realEnvModule.env,
    openai: openaiEnv,
    queue: queueEnv,
    // A getter, because `addressEnv` is written *after* this object is built and
    // a plain property would have snapshotted the value - the same trap the
    // header warns about for primitive exports.
    get supportEmailAddress() {
      return addressEnv.supportEmailAddress;
    },
  },
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
 * A model that answers in the shape `Output.object` expects: **the object
 * itself**, with no wrapper.
 *
 * Worth a helper of its own next to `choosing()` precisely because the two
 * differ on the wire and nothing in the types says so. `Output.choice` nests its
 * answer under `result`; `Output.object` validates the bare object against the
 * schema. Using the wrong one produces a schema-validation throw that reads like
 * a prompt bug, which is a confusing afternoon.
 */
export function deciding(answer: { canAnswer: boolean; reply: string }) {
  return answering(JSON.stringify(answer));
}

/**
 * A reply long enough to clear `MIN_REPLY_LENGTH` and drawn from the fake
 * knowledge base's section 7, so it is the kind of answer the feature exists to
 * send. It mentions neither AI nor money, which is what makes it usable as the
 * default in tests about everything else.
 */
export const DEFAULT_AUTO_REPLY =
  "Thanks for getting in touch. Please clear your browser cache, update to the latest Chrome or Edge, and disable any browser extensions, then try the lesson again.";

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
    autoResolvedAt: null,
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

// --- 4d. the database, for the auto-resolver ---------------------------------

/**
 * The row the auto-resolver reads, and what its write reports.
 *
 * A registry of its own rather than widening `classifyRow`, because the two
 * services read the same table through the same `findUnique` with **different
 * `select`s**, and both test files assert on the exact `select` argument. One
 * union row would make the classifier's assertions lie and `resetFakes()`
 * ambiguous about which service it was resetting.
 */
export type AutoResolveTicketRow = {
  subject: string;
  body: string;
  status: TicketStatus;
  autoResolvedAt: Date | null;
  _count: { messages: number };
};

export const autoResolveRow = {
  ticket: null as AutoResolveTicketRow | null,
  /** What the guarded `updateMany` reports. `0` is a race lost to an agent. */
  updatedCount: 1,
  findError: undefined as unknown,
  updateError: undefined as unknown,
  /** What the transaction itself throws, if anything - a database hiccup. */
  transactionError: undefined as unknown,
};

export function autoResolveTicketRow(
  overrides: Partial<AutoResolveTicketRow> = {},
): AutoResolveTicketRow {
  return {
    subject: "Videos are not playing",
    body: "Hello, the lesson videos will not play for me. What should I try?",
    status: TicketStatus.OPEN,
    autoResolvedAt: null,
    _count: { messages: 1 },
    ...overrides,
  };
}

/** Everything the fake transaction recorded, so a test can assert on the write. */
export const txUse = {
  updateManys: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
  messages: [] as Record<string, unknown>[],
  ticketUpdates: [] as unknown[],
};

const txTicketUpdateMany = mock(
  async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    txUse.updateManys.push(args);
    if (autoResolveRow.updateError) throw autoResolveRow.updateError;
    return { count: autoResolveRow.updatedCount };
  },
);

const txMessageCreate = mock(async (args: { data: Record<string, unknown> }) => {
  txUse.messages.push(args.data);
  return { id: 99, createdAt: new Date("2026-09-28T12:00:00.000Z") };
});

const txTicketUpdate = mock(async (args: unknown) => {
  txUse.ticketUpdates.push(args);
  return {};
});

/**
 * The transaction client `serializable()` hands its callback.
 *
 * `message.create` and `ticket.update` are here because **`addMessage` is the
 * real helper**: the auto-resolver writes its reply through the inbound path's
 * own function, and faking that out would stop these tests saying anything about
 * what actually gets stored. The same instinct as using the AI SDK's own mock
 * model rather than stubbing `generateText` - replace the boundary, not the code
 * under it.
 */
const transactionClient = {
  ticket: { updateMany: txTicketUpdateMany, update: txTicketUpdate },
  message: { create: txMessageCreate },
};

/**
 * One `mock.module`, two row registries, dispatched on the `select`.
 *
 * The dispatch exists because `mock.module` is process-global: the classifier
 * and the auto-resolver both call `prisma.ticket.findUnique`, and a second
 * registration for the second service is exactly the mistake this file's header
 * records breaking the suite twice. `autoResolvedAt` is only ever asked for by
 * the auto-resolver, so it discriminates unambiguously - and asking the
 * *request* which service it came from is what keeps both test files able to
 * assert their own `select` verbatim.
 */
const ticketFindUniqueDispatch = mock(async (args: { select?: Record<string, unknown> }) => {
  if (args?.select?.autoResolvedAt) {
    if (autoResolveRow.findError) throw autoResolveRow.findError;
    return autoResolveRow.ticket;
  }
  return ticketFindUnique(args);
});

/**
 * Both forms of `$transaction`, because both are now used: the callback form by
 * every check-then-write under `serializable()`, and the **array** form by the
 * dashboard, which runs its two reads in one `RepeatableRead` snapshot. The array
 * holds already-pending promises, so awaiting them is all the real thing does
 * that matters here - there is no isolation to simulate in a fake.
 */
export const transaction = mock(
  async (
    work: ((tx: typeof transactionClient) => Promise<unknown>) | readonly Promise<unknown>[],
    _options?: unknown,
  ) => {
    if (autoResolveRow.transactionError) throw autoResolveRow.transactionError;
    if (Array.isArray(work)) return Promise.all(work);
    return (work as (tx: typeof transactionClient) => Promise<unknown>)(transactionClient);
  },
);

/**
 * `prisma.$queryRaw`, which the dashboard service calls twice - once for the
 * scalar aggregate and once for the daily volume series.
 *
 * A tagged template, so the fake receives the SQL fragments and the bound values
 * as separate arguments - and recording both is the point rather than
 * incidental: the enum rule says `TicketStatus.OPEN` must arrive as a *bound
 * value*, never typed into the SQL as `'OPEN'`, and that is only checkable if
 * the two are kept apart.
 *
 * **One registration, two row sets, dispatched on the SQL** - the same rule
 * `ticketFindUniqueDispatch` below follows, and for the same reason: a second
 * `mock.module` for the same module is the mistake this file's header records
 * breaking the suite twice. `generate_series` appears only in the volume query,
 * so it discriminates unambiguously.
 *
 * Both row sets are plain arrays rather than typed rows, because the service has
 * to survive a driver handing a numeric back as a string - a shape the real
 * types do not admit.
 */
export const queryRawUse = {
  metricsRows: [] as unknown[],
  volumeRows: [] as unknown[],
  error: undefined as Error | undefined,
  /** Every call, as `{ sql, values }`, in order. */
  calls: [] as { sql: string; values: unknown[] }[],
};

export const queryRaw = mock(async (strings: unknown, ...values: unknown[]) => {
  const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
  queryRawUse.calls.push({ sql, values });
  if (queryRawUse.error) throw queryRawUse.error;
  return sql.includes("generate_series") ? queryRawUse.volumeRows : queryRawUse.metricsRows;
});

mock.module("../lib/prisma.ts", () => ({
  prisma: {
    ticket: { findUnique: ticketFindUniqueDispatch, updateMany: ticketUpdateMany },
    $queryRaw: queryRaw,
    // `serializable()` is the real helper, so what needs replacing is the
    // transaction under it. The callback form only: the one caller that passes an
    // array is in `services/tickets.ts`, which is faked wholesale above.
    $transaction: transaction,
  },
}));

// --- 4e. the knowledge base --------------------------------------------------

/**
 * The knowledge base the auto-resolver answers from, mutable so a test can take
 * it away. That matters more than it looks: an absent knowledge base is the
 * feature's entire off switch, so the off state needs testing as carefully as
 * the on one.
 */
export const knowledgeBaseUse = {
  text: null as string | null,
};

/**
 * A miniature knowledge base with the three sections the tests turn on: 4 so a
 * refund *policy* question is answerable, 7 so a technical question is, and 10
 * so the escalation rules are in the prompt where the tests look for them.
 */
export const DEFAULT_KNOWLEDGE_BASE = [
  "# Support Knowledge Base",
  "",
  "## 4. Refund Policy",
  "- 30-day money-back guarantee.",
  "- Full refund if requested within 30 days of purchase.",
  "",
  "## 7. Technical Issues",
  "### Q: Videos are not playing.",
  "Clear your browser cache, use the latest Chrome or Edge, disable extensions.",
  "",
  "## 10. Escalation Rules (Internal Policy)",
  "Escalate to a human if the user threatens legal action, requests a refund outside",
  "the 30-day window, disputes a charge, raises account security, or confidence is low.",
].join("\n");

export const knowledgeBase = mock((): string | null => knowledgeBaseUse.text);

mock.module("../lib/knowledge-base.ts", () => ({
  knowledgeBase,
  knowledgeBasePath: mock(() => "/fake/knowledge-base.md"),
  resetKnowledgeBase: mock(() => {}),
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

  addressEnv.supportEmailAddress = undefined;

  autoResolveRow.ticket = autoResolveTicketRow();
  autoResolveRow.updatedCount = 1;
  autoResolveRow.findError = undefined;
  autoResolveRow.updateError = undefined;
  autoResolveRow.transactionError = undefined;
  txUse.updateManys.length = 0;
  txUse.messages.length = 0;
  txUse.ticketUpdates.length = 0;
  txTicketUpdateMany.mockClear();
  txMessageCreate.mockClear();
  txTicketUpdate.mockClear();
  ticketFindUniqueDispatch.mockClear();
  transaction.mockClear();

  queryRawUse.metricsRows = [];
  queryRawUse.volumeRows = [];
  queryRawUse.error = undefined;
  queryRawUse.calls.length = 0;
  queryRaw.mockClear();

  knowledgeBaseUse.text = DEFAULT_KNOWLEDGE_BASE;
  knowledgeBase.mockClear();

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
