/**
 * Classifying a ticket into one of the three categories, automatically, when it
 * arrives.
 *
 * Covers tasks 5.3, 5.4, 5.5 and 5.9 of the implementation plan, on OpenAI rather
 * than the Claude the plan named - the same deviation the two on-demand features
 * already made, recorded in `tech-stack.md`.
 *
 * **It runs in a pg-boss worker, off the webhook's thread entirely.**
 * `services/inbound-email.ts` enqueues `ticket.classify` inside the transaction
 * that creates the ticket; `jobs/classify-ticket.ts` is the handler that calls
 * this. The webhook has answered the provider long before a model is asked
 * anything.
 *
 * **The error contract is the queue's, which is the opposite of what it was.**
 * This used to be called with a bare `void` and so had to swallow everything.
 * Now pg-boss is holding the promise, and a thrown error is how a job earns its
 * retry - three attempts with exponential backoff. So:
 *
 * - **Transient failures throw**: a rate limit, a timed-out provider, a model
 *   that answered with something unparseable, a database hiccup. All are worth
 *   another go in half a minute, and that retry is the entire reason to put this
 *   on a queue rather than firing it and hoping.
 * - **Permanent outcomes return `null`** and are logged, not thrown: no such
 *   ticket, already classified, an agent got there first, or a server with no
 *   `OPENAI_API_KEY`. Retrying any of them would fail in exactly the same way
 *   three more times and then fill the dead-letter queue with noise.
 *
 * Two properties survive the change. **A failure still cannot cost a ticket**
 * (task 5.9): the ticket, its message and the `RawEmail` row are committed before
 * the worker picks the job up, so a classification that fails for good leaves a
 * working, uncategorised ticket. And **`category IS NULL` is still the seam** a
 * backfill would claim - for the tickets that predate the classifier, and for the
 * ones whose jobs exhausted their retries.
 *
 * There is no `LlmCall` audit row (task 5.2) and no prompt caching (5.8); neither
 * exists yet for the other two features either.
 */
import { generateText, Output } from "ai";
import { env } from "../env.ts";
import { TicketCategory } from "../generated/prisma/enums.ts";
import { openAiModel } from "../lib/ai.ts";
import { prisma } from "../lib/prisma.ts";

/**
 * What belongs in each category, in the model's words rather than ours.
 *
 * A `Record` keyed by the enum, so adding a fourth category is a compile error
 * until it has a definition here - the same device `routes/tickets.ts` uses for
 * its validation tables. It is also the single source of the option list below, so
 * the categories the model may choose from and the categories it is told about
 * cannot drift apart.
 */
const CATEGORY_GUIDE: Record<TicketCategory, string> = {
  [TicketCategory.GENERAL_QUESTION]:
    "A question about the course, the content, enrolment, admin, deadlines, certificates or anything else that is neither broken software nor a request for money back.",
  [TicketCategory.TECHNICAL_QUESTION]:
    "Something is not working: an error message, a page or video that will not load, a login or password that will not work, a download that fails, a broken link, an app or device problem.",
  [TicketCategory.REFUND_REQUEST]:
    "The student wants money back, or is disputing a charge: a refund, a cancellation with money returned, a double charge, a billing complaint.",
};

/**
 * The options the model may answer with. `Output.choice` turns these into a JSON
 * schema whose `enum` is this list, so an invalid category is not something the
 * provider can return - it is refused by the schema rather than parsed and
 * checked afterwards (task 5.3).
 *
 * The cast is the one unavoidable loss: `Object.keys` is typed `string[]`, and the
 * keys of a `Record<TicketCategory, …>` are exactly the categories.
 */
const CATEGORIES = Object.keys(CATEGORY_GUIDE) as TicketCategory[];

/**
 * How much of the opening message the model is shown. A classification turns on
 * the first paragraph in practice; the rest is signature, quoted mail and detail
 * that costs tokens without changing the answer.
 */
const MAX_BODY_LENGTH = 4_000;

/**
 * Generous for an answer that is one word, because the budget is shared with the
 * model's own reasoning tokens: too tight and a reasoning model spends the lot
 * thinking and returns nothing, which arrives here as a parse failure rather than
 * as the obvious "ran out of room".
 */
const MAX_OUTPUT_TOKENS = 2_000;

/**
 * Shorter than the two interactive features' 30s. Nobody is watching this one, so
 * a slow provider costs a ticket its category rather than an agent their time -
 * and a background call that hangs for half a minute is a background call still
 * holding a connection when the next email arrives.
 */
const TIMEOUT_MS = 20_000;

/**
 * Every ticket gets one of the three. `project-scope.md` says so in as many words
 * - "every ticket belongs to a single category" - so there is no fourth "unsure"
 * option and no abstaining: doubt goes to General Question, which is the catch-all
 * by construction. An agent can correct it on the detail page, which is the other
 * half of what the scope promises.
 */
const INSTRUCTIONS = [
  "You classify incoming support tickets for a tech ed company's helpdesk.",
  "You are given the subject and the opening message of one ticket. Choose the single category it belongs to.",
  "",
  "The categories:",
  ...CATEGORIES.map((category) => `- ${category}: ${CATEGORY_GUIDE[category]}`),
  "",
  "Rules:",
  `- Choose exactly one. If it is not clearly technical and not about money, choose ${TicketCategory.GENERAL_QUESTION}.`,
  "- Classify what the student is asking for, not the tone they ask in. An angry question is still a question.",
  `- A student who is angry about a technical fault but has not asked for money back is ${TicketCategory.TECHNICAL_QUESTION}, not ${TicketCategory.REFUND_REQUEST}.`,
  "- Judge only by what the message says. Do not guess at what they might want next.",
].join("\n");

/**
 * Classify one ticket and record the result, unless somebody got there first.
 *
 * Returns the category it stored, or `null` when there was deliberately nothing
 * to store. **Throws on a transient failure**, which is how the pg-boss worker
 * above it earns the job a retry - see the note at the top of this file for which
 * failures are which.
 */
export async function classifyTicket(ticketId: number): Promise<TicketCategory | null> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { subject: true, body: true, category: true },
  });

  if (!ticket) {
    // Nothing deletes a ticket, so this is a job for an id that never existed -
    // a programming error, and not one a retry would fix.
    console.warn(`Not classifying ticket ${ticketId}: no such ticket.`);
    return null;
  }

  // Already classified, so there is nothing to decide and no reason to pay for a
  // decision. Reachable because the job runs after the ticket is committed: an
  // agent can open a brand-new ticket and set its category before the worker
  // picks the job up.
  if (ticket.category !== null) return null;

  // A server with no key does not do this, which is a configuration rather than a
  // failure - so it is answered here instead of being left to throw, because
  // three retries and a dead-letter row would say something is wrong when
  // nothing is. Checked against `env` rather than by catching the 503, so the
  // distinction does not depend on a message.
  if (!env.openai.apiKey) {
    console.info(`Not classifying ticket ${ticketId}: AI features are not configured.`);
    return null;
  }

  const category = await askModel(ticket.subject, ticket.body);

  // **The write is conditional, and that is the important line in this file.**
  // Between the read above and here an agent may have classified the ticket by
  // hand, and a human's answer must not be overwritten by a machine's - so the
  // update matches on `category: null` and quietly does nothing if it is no
  // longer null. An `update` by id would have clobbered them.
  const { count } = await prisma.ticket.updateMany({
    where: { id: ticketId, category: null },
    data: { category },
  });

  if (count === 0) {
    console.info(
      `Not classifying ticket ${ticketId} as ${category}: it was categorised while the model was thinking.`,
    );
    return null;
  }

  return category;
}

/**
 * Ask the model, with the category list enforced by the response schema rather
 * than by parsing what comes back.
 */
async function askModel(subject: string, body: string): Promise<TicketCategory> {
  const { output } = await generateText({
    model: openAiModel(),
    instructions: INSTRUCTIONS,
    prompt: [`Subject: ${subject}`, "", "Opening message:", truncate(body, MAX_BODY_LENGTH)].join(
      "\n",
    ),
    output: Output.choice({ options: CATEGORIES }),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    providerOptions: {
      openai: {
        // A single label from a short message: there is nothing here to reason
        // about at length, and a classification nobody is waiting for should
        // still be the cheapest call in the system.
        reasoningEffort: "low",
        textVerbosity: "low",
        // As everywhere else: the prompt is a student's own words.
        store: false,
      },
    },
  });

  return output;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
