/**
 * Answering a new ticket from the knowledge base, and resolving it, when the
 * knowledge base definitively covers what was asked.
 *
 * This is the first thing in the system that **answers a student rather than
 * describing one to an agent**. The polisher rewrites what an agent typed, the
 * summariser tells an agent what a thread says, the classifier files a ticket -
 * all three produce text a human reads and can discard. This one writes a reply
 * onto the ticket in the support team's name and marks it RESOLVED, with nobody
 * in between. Everything below is shaped by that, and by the one rule it all
 * reduces to:
 *
 * > **Coverage decides, not category.** If `knowledge-base.md` definitively
 * > answers the question, reply and resolve. Anything it does not cover stays
 * > OPEN for a human.
 *
 * Which is why declining is cheap and answering is expensive, and why the
 * prompt, the phrase lists and the guards below are all weighted the same way:
 * a decline costs one agent one ticket, and a wrong answer costs a student a
 * wrong answer they have no reason to doubt.
 *
 * **Four things it deliberately does not do.**
 *
 * - **Never CLOSED.** RESOLVED is as far as a machine goes; only a human closes
 *   a ticket. A student's reply reopens a RESOLVED ticket by the ordinary
 *   inbound rule, which is what makes RESOLVED the safe end state here.
 * - **Nothing in the thread mentions AI or automation.** No footer, no
 *   disclaimer, and `fromName` is the support team rather than a robot's name.
 *   `Ticket.autoResolvedAt` is the *only* record that this happened, and the
 *   detail page's notice is the only place it surfaces. The reply reads as a
 *   reply because it is one; what an agent needs to know is on the page they
 *   read it from, not stapled to the text the student receives.
 * - **No feature flag.** It runs when there is a knowledge base to answer from
 *   (`lib/knowledge-base.ts`) and an `OPENAI_API_KEY` to answer with. Two
 *   conditions that are each independently necessary are a better gate than a
 *   boolean that can disagree with both.
 * - **Nothing is emailed.** The reply is stored on the ticket, like an agent's
 *   own (tasks 4.12-4.15 are still outstanding), so `rfcMessageId` stays null.
 *
 * **The error contract is the classifier's, for the classifier's reasons.** This
 * runs in a pg-boss worker off `jobs/auto-resolve-ticket.job.ts`, so:
 *
 * - **Transient failures throw**, which is how a job earns its three retries: a
 *   rate limit, a timed-out provider, an answer the response schema refused, a
 *   database hiccup.
 * - **Permanent outcomes return `null`** and are logged: no knowledge base, no
 *   API key, a ticket that is not OPEN, a ticket already auto-resolved, a thread
 *   rather than an arrival, an escalation phrase, a model that declined, an
 *   answer that failed a guard, or a race lost to an agent. Retrying any of them
 *   fails identically three more times and then fills the dead-letter queue with
 *   work that could never succeed.
 *
 * A failure cannot cost a ticket, the same property task 5.9 bought for
 * classification: the ticket, its message and the `RawEmail` row are all
 * committed before the worker starts, so an auto-resolution that fails for good
 * leaves a working, open ticket - which is the outcome the whole feature degrades
 * towards.
 */
import { MAX_REPLY_LENGTH } from "@helpdesk/core/schemas/tickets";
import { generateText, Output } from "ai";
import { z } from "zod";
import { env } from "../env.ts";
import { TicketStatus } from "../generated/prisma/enums.ts";
import { openAiModel } from "../lib/ai.ts";
import { knowledgeBase } from "../lib/knowledge-base.ts";
import { prisma } from "../lib/prisma.ts";
import { serializable } from "../lib/transaction.ts";
import { addMessage } from "./inbound-email.ts";

/**
 * Who the reply is from, as the student and the agent both see it.
 *
 * It says the support team and not a person, because no person wrote it and
 * putting a colleague's name on it would be the one lie this feature must not
 * tell. It does not say "automated" either - see the note at the top of this
 * file for why the thread is silent about that.
 */
const SUPPORT_FROM_NAME = "Code with Mosh Support Team";

/**
 * The address the reply is attributed to when `SUPPORT_EMAIL_ADDRESS` is not
 * configured, which outside production is the normal case.
 *
 * `Message.fromEmail` is required, so there has to be something. A visibly
 * local placeholder is better than a plausible-looking invented address: nobody
 * reading a thread mistakes `support@localhost` for a mailbox that works.
 */
const FALLBACK_FROM_EMAIL = "support@localhost";

/**
 * Shortest answer worth sending. A model that has decided to answer and then
 * produced twelve characters has not answered - it has acknowledged - and
 * "Thanks, we'll look into it." on a resolved ticket is worse than silence,
 * because the ticket then leaves the queue.
 */
const MIN_REPLY_LENGTH = 40;

/**
 * How much of the opening message the model is shown. The same budget the
 * classifier uses, for the same reason: the question is in the first paragraph
 * and the rest is signature and quoted mail.
 */
const MAX_BODY_LENGTH = 4_000;

/**
 * Generous, because the budget is shared with the model's own reasoning tokens
 * and this is the one call here that reasons at length *and* writes prose. Too
 * tight and the reply is truncated mid-sentence, which arrives as a schema
 * failure rather than as the obvious "ran out of room".
 */
const MAX_OUTPUT_TOKENS = 4_000;

/**
 * Longer than the classifier's 20s, matching the interactive features instead.
 * Nobody is waiting, but this call reasons harder and writes more, and a timeout
 * costs a reply rather than a label.
 *
 * Note it now exceeds `STOP_TIMEOUT_MS` in `lib/queue.ts` (25s), so a graceful
 * shutdown can cut this call short - which is safe rather than lossy: nothing is
 * written until the model has answered, the job is never completed, and pg-boss
 * hands it to whoever starts next once it expires.
 */
const TIMEOUT_MS = 30_000;

/**
 * §10 of the knowledge base - "Escalation Rules (Internal Policy)" - enforced
 * here in code, not only asked for in the prompt.
 *
 * The prompt carries those rules too, and the model generally follows them. This
 * list is the half that does not depend on it: a phrase here overrules the model
 * whatever it decided. **Substring-ish matching is crude, and acceptable only
 * because of the direction it fails in** - a phrase list can only ever escalate
 * *more* tickets than the model would, never auto-resolve more. A false positive
 * costs an agent one ticket they were going to read anyway. There is no false
 * negative that this list creates.
 *
 * Matched with word boundaries rather than `String.includes`, which is not
 * pedantry: `sue` is inside `issue`, and `issue` is inside most technical
 * tickets, so a bare substring check would escalate nearly every §7 question the
 * knowledge base answers best. Boundaries keep the list a veto on what was
 * actually said.
 *
 * **Why money requests are here and the refund *policy* is not.** §10 says to
 * escalate a refund requested outside the 30-day window, and this system knows
 * neither the purchase date nor how much of the course was watched - so it cannot
 * establish that a request is *inside* the window, and "unable to tell" is not
 * the same as "inside". A request for money therefore escalates. A *question
 * about the refund policy* does not: §4 answers it completely, and sending that
 * answer promises nobody anything. That distinction is the whole reason there are
 * two lists in this file.
 *
 * One §10 rule is deliberately absent: "the system confidence score is low" is
 * not a phrase and never will be. It is `canAnswer: false` and the guards below.
 */
const LEGAL_PHRASES = [
  "legal action",
  "legal advice",
  "lawyer",
  "attorney",
  "solicitor",
  "sue",
  "suing",
  "court",
  "litigation",
  "small claims",
  "trading standards",
  "ombudsman",
  "cease and desist",
] as const;

const DISPUTE_PHRASES = [
  "chargeback",
  "charge back",
  "dispute",
  "disputing",
  "disputed",
  "fraud",
  "fraudulent",
  "charged twice",
  "double charge",
  "double charged",
  "charged me twice",
  "reverse the charge",
  "stop payment",
] as const;

const SECURITY_PHRASES = [
  "hacked",
  "hacker",
  "compromised",
  "unauthorised access",
  "unauthorized access",
  "unauthorised charge",
  "unauthorized charge",
  "security breach",
  "data breach",
  "phishing",
  "account takeover",
  "stolen",
] as const;

/**
 * Asking for money back, as against asking what the policy is.
 *
 * Note what is deliberately *not* here: a bare `refund`. "What is your refund
 * policy?" and "How do I request a refund?" are section 4 questions with
 * complete answers in the knowledge base, and escalating them is the "money
 * always escalates" rule this feature explicitly does not follow. These phrases
 * catch the *request*; the question goes through.
 */
const MONEY_REQUEST_PHRASES = [
  "i want a refund",
  "i want my refund",
  "i'd like a refund",
  "i would like a refund",
  "please refund",
  "refund me",
  "issue a refund",
  "my money back",
  "want my money back",
  "give me my money",
  "cancel and refund",
] as const;

/** Checked against the incoming subject and body. All four groups. */
const ESCALATION_PHRASES = [
  ...LEGAL_PHRASES,
  ...DISPUTE_PHRASES,
  ...SECURITY_PHRASES,
  ...MONEY_REQUEST_PHRASES,
];

/**
 * Checked against the **model's own reply**, and deliberately narrower: legal,
 * dispute and security only, with the money phrases left out.
 *
 * The omission is the point, and it is the subtlest thing in this file - so
 * before adding them back, read line 65 of `knowledge-base.md`: *"30-day
 * money-back guarantee"*. That sentence is the correct, complete, section-4
 * answer to "what is your refund policy?", and `my money back` is inside it.
 * Checking the money phrases against the reply would therefore self-escalate
 * exactly the answer this feature exists to send, and the symptom would look
 * like a prompt problem rather than a list problem.
 *
 * What remains is the set of subjects a reply has no business raising by itself:
 * if the model is writing about lawyers, chargebacks or a compromised account,
 * the ticket belongs to a person however confident it sounded. A ticket whose
 * *incoming* text mentions any of them never reaches here at all, so this list
 * only ever catches the model bringing one up unprompted.
 */
const REPLY_ESCALATION_PHRASES = [
  ...LEGAL_PHRASES,
  ...DISPUTE_PHRASES,
  ...SECURITY_PHRASES,
];

/**
 * One case-insensitive, word-bounded pattern per phrase, compiled once.
 *
 * `\b` on both ends works for a multi-word phrase as well as a single word, and
 * the haystack has its whitespace collapsed first so a phrase broken across a
 * line in the original mail still matches.
 */
function patterns(phrases: readonly string[]): { phrase: string; pattern: RegExp }[] {
  return phrases.map((phrase) => ({
    phrase,
    pattern: new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
  }));
}

const INCOMING_PATTERNS = patterns(ESCALATION_PHRASES);
const REPLY_PATTERNS = patterns(REPLY_ESCALATION_PHRASES);

/** The first phrase in `list` that `text` contains, or undefined. */
function escalationPhrase(
  text: string,
  list: { phrase: string; pattern: RegExp }[],
): string | undefined {
  const haystack = text.replace(/\s+/g, " ");
  return list.find(({ pattern }) => pattern.test(haystack))?.phrase;
}

/**
 * What the model answers with.
 *
 * Two fields and both required, because the OpenAI provider sends this as a
 * *strict* JSON schema: an optional field, a default or a string length rule
 * would be refused by the provider at runtime rather than by the typechecker
 * here. So `reply` is `""` when there is nothing to say, and its length is
 * checked in code below.
 */
const ANSWER_SCHEMA = z.object({
  canAnswer: z
    .boolean()
    .describe(
      "True only if the knowledge base clearly and completely answers this ticket. False otherwise.",
    ),
  reply: z
    .string()
    .describe("The reply to send to the student. An empty string when canAnswer is false."),
});

/**
 * The instructions, written to make **declining the default**.
 *
 * The asymmetry is stated out loud rather than implied, because it is the only
 * thing that reliably moves a model off wanting to be helpful: answering sends
 * text to a student under the support team's name with nobody reading it first,
 * and declining costs one agent one ticket they would have read anyway.
 *
 * §10 is carried verbatim as a hard override. The three prohibitions at the end
 * are the ones a reply must not break: no invention, no addressing a question
 * the knowledge base does not cover, and nothing about being automated.
 */
const INSTRUCTIONS = [
  "You answer incoming support tickets for Code with Mosh, an online programming course provider, using only the support knowledge base you are given.",
  "",
  "You decide one thing: whether the knowledge base clearly and completely answers this ticket.",
  "",
  "The two outcomes are not equally expensive, and you should weigh them accordingly:",
  "- `canAnswer: true` sends your reply to the student, signed by the support team, and marks the ticket resolved. No human reads it first.",
  "- `canAnswer: false` costs one support agent reading one ticket. Nothing is sent and nothing is lost.",
  "So when the two are close, choose false. A student misled by a confident wrong answer has no reason to doubt it; a student waiting for a colleague simply waits.",
  "",
  "Set `canAnswer: false`, with `reply` an empty string, whenever any of these is true:",
  "- The knowledge base does not answer the question, or answers only part of it.",
  "- Answering would need you to generalise, infer, combine sections into a new rule, or add anything of your own.",
  "- Answering would need to know something about this particular student: their account, their order, their payment, their progress, or what a specific error says. The knowledge base describes policy and general troubleshooting; it knows nothing about any individual.",
  "- The message asks several things and the knowledge base covers only some of them.",
  "",
  "Then, regardless of coverage, the knowledge base's own escalation policy (section 10) overrides everything above. Set `canAnswer: false` if:",
  "- The user threatens legal action.",
  "- The user requests a refund outside the 30-day window.",
  "- The user disputes a charge or mentions a chargeback.",
  "- The issue involves account security concerns.",
  "- Your confidence is low.",
  "Note the difference those rules turn on: a question *about* the refund policy is answerable from the knowledge base, because telling someone the policy promises them nothing. A request *for* a refund is not, because you cannot see when they bought the course or how much of it they have watched.",
  "",
  "When you do answer, write the reply itself in `reply`:",
  "- Address the student directly and answer their question using the knowledge base's own facts and steps.",
  "- Do not invent anything the knowledge base does not say - no timescales, prices, links, account details or promises.",
  "- Keep it to two short paragraphs or a short list of steps.",
  "- Sign off as the support team. Do not use a personal name.",
  "- Say nothing about AI, automation, a system, a bot, or this reply being generated. Write as the support team, because that is who it is from.",
  "- Do not tell the student to contact support. They already have.",
].join("\n");

/**
 * Answer one ticket from the knowledge base and resolve it, or leave it alone.
 *
 * Returns the reply it stored, or `null` when there was deliberately nothing to
 * store. **Throws on a transient failure**, which is how the pg-boss worker above
 * it earns the job a retry - see the note at the top of this file.
 */
export async function autoResolveTicket(ticketId: number): Promise<string | null> {
  // --- the free refusals, all of them before anything is paid for -----------

  const knowledge = knowledgeBase();
  if (!knowledge) {
    // The feature's own off switch. Logged by `lib/knowledge-base.ts` on the
    // first read rather than once per ticket.
    return null;
  }

  if (!env.openai.apiKey) {
    console.info(`Not auto-resolving ticket ${ticketId}: AI features are not configured.`);
    return null;
  }

  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: {
      subject: true,
      body: true,
      status: true,
      autoResolvedAt: true,
      _count: { select: { messages: true } },
    },
  });

  if (!ticket) {
    // Nothing deletes a ticket, so this is a job for an id that never existed -
    // a programming error, and not one a retry would fix.
    console.warn(`Not auto-resolving ticket ${ticketId}: no such ticket.`);
    return null;
  }

  // An agent has already dealt with it. Reachable because the job runs after the
  // ticket is committed, so a fast colleague can resolve a brand-new ticket
  // inside the second or two before the worker picks it up.
  if (ticket.status !== TicketStatus.OPEN) {
    console.info(`Not auto-resolving ticket ${ticketId}: it is ${ticket.status}, not OPEN.`);
    return null;
  }

  if (ticket.autoResolvedAt !== null) {
    console.info(`Not auto-resolving ticket ${ticketId}: it has already been auto-resolved.`);
    return null;
  }

  // **A thread is not an arrival.** The prompt is built from `Ticket.body`, which
  // is the *opening* message denormalised - so on a ticket that has moved on,
  // this would answer the first question as though the conversation after it had
  // not happened. Only enqueued for a new ticket, and checked again here because
  // a reply can land between the enqueue and the worker.
  if (ticket._count.messages !== 1) {
    console.info(
      `Not auto-resolving ticket ${ticketId}: it has ${ticket._count.messages} messages, so it is a conversation rather than an arrival.`,
    );
    return null;
  }

  const body = ticket.body.trim();
  if (body.length === 0) {
    // A subject with no body is a legitimate ticket and an unanswerable one:
    // there is no question to look up.
    console.info(`Not auto-resolving ticket ${ticketId}: it has no message body to answer.`);
    return null;
  }

  // §10, enforced before the model is asked rather than after it answers.
  const escalation = escalationPhrase(`${ticket.subject}\n${body}`, INCOMING_PATTERNS);
  if (escalation) {
    console.info(
      `Not auto-resolving ticket ${ticketId}: it must reach a human ("${escalation}" - knowledge base section 10).`,
    );
    return null;
  }

  // --- the model ------------------------------------------------------------

  const answer = await askModel(knowledge, ticket.subject, body);

  if (!answer.canAnswer) {
    console.info(
      `Not auto-resolving ticket ${ticketId}: the knowledge base does not answer it.`,
    );
    return null;
  }

  const reply = answer.reply.trim();

  // Decided to answer and then said almost nothing. An acknowledgement on a
  // ticket that is about to leave the queue is worse than no reply at all.
  if (reply.length < MIN_REPLY_LENGTH) {
    console.info(
      `Not auto-resolving ticket ${ticketId}: the reply was only ${reply.length} characters.`,
    );
    return null;
  }

  // The ceiling the reply composer and `POST /api/tickets/:id/messages` already
  // enforce, imported rather than restated: a stored reply no agent could have
  // typed would be a second definition of what a reply is.
  if (reply.length > MAX_REPLY_LENGTH) {
    console.info(
      `Not auto-resolving ticket ${ticketId}: the reply was ${reply.length} characters, over the ${MAX_REPLY_LENGTH} limit.`,
    );
    return null;
  }

  const replyEscalation = escalationPhrase(reply, REPLY_PATTERNS);
  if (replyEscalation) {
    console.info(
      `Not auto-resolving ticket ${ticketId}: the reply raised something for a human ("${replyEscalation}").`,
    );
    return null;
  }

  // --- the write ------------------------------------------------------------

  return write(ticketId, reply);
}

/**
 * Resolves the ticket and appends the reply, in one serializable transaction.
 *
 * **The order of the two writes is the important thing in this function**, and
 * reversing it is the bug worth naming. The model call took seconds, and an
 * agent may have resolved, closed or replied to the ticket in them - so the
 * status write goes first, matching on `{ status: OPEN, autoResolvedAt: null }`,
 * and its count is what decides whether anything else happens. Write the message
 * first and a lost race leaves an outbound reply from the support team on a
 * ticket the agent is working, with nothing anywhere to say where it came from.
 *
 * A lost race returns `null` rather than throwing: it is a permanent outcome, and
 * throwing would spend two more model calls losing it twice more.
 */
async function write(ticketId: number, reply: string): Promise<string | null> {
  return serializable(async (tx) => {
    // Inside the callback, which `serializable` re-runs on a conflict: a retry
    // should stamp the attempt that actually committed, not the one that lost.
    const now = new Date();

    const { count } = await tx.ticket.updateMany({
      // RESOLVED, never CLOSED. Closing is a judgement only a person makes, and
      // a student's reply reopens a RESOLVED ticket by the ordinary inbound
      // rule - which is what makes this the safe end state for a machine.
      where: { id: ticketId, status: TicketStatus.OPEN, autoResolvedAt: null },
      // `resolvedAt` and `autoResolvedAt` are the same instant here and are
      // still two columns, because they answer different questions: one is when
      // the ticket left the queue, which a human resolution sets too, and the
      // other is that the reply was not a colleague's. They part company the
      // moment a student replies - the reopen clears the first and keeps the
      // second.
      data: { status: TicketStatus.RESOLVED, autoResolvedAt: now, resolvedAt: now },
    });

    if (count === 0) {
      console.info(
        `Not auto-resolving ticket ${ticketId}: somebody worked on it while the model was writing.`,
      );
      return null;
    }

    // Through the inbound path's own helper, which moves `lastMessageAt` with the
    // message - an auto-reply is activity, and a reply that did not move it would
    // be invisible to the queue's default ordering. No `rfcMessageId`: nothing
    // was emailed, and minting one would claim otherwise.
    await addMessage(tx, ticketId, {
      direction: "OUTBOUND",
      fromEmail: env.supportEmailAddress ?? FALLBACK_FROM_EMAIL,
      fromName: SUPPORT_FROM_NAME,
      body: reply,
    });

    return reply;
  });
}

/**
 * Ask the model, with the answer's shape enforced by the response schema.
 *
 * `Output.object` rather than parsing: an answer of the wrong shape throws inside
 * the SDK, which is a transient failure and earns the job its retry. Note the
 * wire difference from `Output.choice`, which the classifier uses - that one
 * wraps its answer in `{ result }` and this one is the object itself.
 */
async function askModel(
  knowledge: string,
  subject: string,
  body: string,
): Promise<z.infer<typeof ANSWER_SCHEMA>> {
  const { output } = await generateText({
    model: openAiModel(),
    instructions: INSTRUCTIONS,
    // The knowledge base goes in the user prompt rather than the instructions,
    // fenced so its own headings cannot read as instructions to the model: the
    // system message is about how to behave, and keeping the document out of it
    // is also what would let prompt caching (task 5.8) help here later.
    prompt: [
      "--- BEGIN KNOWLEDGE BASE ---",
      knowledge,
      "--- END KNOWLEDGE BASE ---",
      "",
      "The ticket:",
      `Subject: ${subject}`,
      "",
      "Message:",
      truncate(body, MAX_BODY_LENGTH),
    ].join("\n"),
    output: Output.object({ schema: ANSWER_SCHEMA }),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    providerOptions: {
      openai: {
        // Higher than the other three features' "low", and the one place here
        // worth paying for reasoning: this call decides whether a ticket leaves
        // the queue, and that judgement is exactly the kind cheap reasoning gets
        // wrong expensively.
        reasoningEffort: "medium",
        // The reply should read like a support reply, which is short.
        textVerbosity: "low",
        // As everywhere else, and most pointedly here: the prompt is a student's
        // own words.
        store: false,
      },
    },
  });

  return output;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
