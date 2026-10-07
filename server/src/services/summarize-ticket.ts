/**
 * Summarising a ticket and the conversation on it.
 *
 * The second AI feature, and like the first it **stores nothing**: a summary is
 * generated when an agent asks for one and is gone when they navigate away. That
 * is a deliberate choice rather than a stage on the way to a stored one. A
 * summary saved on the ticket goes stale the moment the next message arrives, and
 * a stale summary is worse than none - an agent who reads "the student is waiting
 * on a refund date" will not notice that the refund was paid two replies ago.
 * Regenerating costs a fraction of a penny; being wrong costs the student.
 *
 * So there is no `Ticket.summary` column, no invalidation to get right, and the
 * endpoint is free to be asked again at any time. What the agent sees is always a
 * summary of the thread as it stands.
 */
import { generateText } from "ai";
import { MessageDirection } from "../generated/prisma/enums.ts";
import { openAiModel } from "../lib/ai.ts";
import { HttpError } from "../middleware/error-handler.ts";
import { getTicket, type PublicMessage, type PublicTicketDetail } from "./tickets.ts";

/**
 * How much of the thread the model is shown.
 *
 * More generous than the polisher's six messages, and for a reason: polishing
 * needs the question a reply is answering, while a summary is a claim about the
 * whole conversation. Cutting the middle out of a thread would produce a summary
 * that is confidently wrong about what was agreed, which is the one thing a
 * summary must not be.
 *
 * The cap still exists, because a pathological thread would otherwise be an
 * unbounded prompt. When it bites, the **oldest** messages go: a summary that is
 * missing the opening request is visibly incomplete, where one missing the latest
 * exchange reads as complete and is not.
 */
const CONTEXT_MESSAGES = 30;
const CONTEXT_BODY_LENGTH = 4_000;

/**
 * The ceiling on the summary itself. A summary longer than this is not a summary,
 * and the point of the feature is to be quicker to read than the thread.
 */
export const MAX_SUMMARY_LENGTH = 2_000;

const MAX_OUTPUT_TOKENS = 1_000;

/** An agent is waiting on a button, so the provider is on a clock. */
const TIMEOUT_MS = 30_000;

/**
 * What the summary is for, and what it must not do. The prohibitions are the
 * polisher's, for the same reason: a summary that invents a commitment, or that
 * answers the student instead of describing the conversation, is worse than no
 * summary at all - because an agent reads it *instead of* the thread, which is
 * the entire point of it.
 */
const INSTRUCTIONS = [
  "You summarise support tickets for a tech ed company's helpdesk team.",
  "An agent is about to pick this ticket up and wants to know where it stands without reading the whole thread.",
  "",
  "Rules:",
  "- Return only the summary. No preamble, no commentary, no markdown fences.",
  "- Cover three things, in this order: what the student is asking for, what has been done or promised so far, and what is still outstanding.",
  "- You may label each of the three with a short plain line of its own. No markdown headings, no bold, no bullet characters.",
  "- Say if nothing has been done yet, or if nothing is outstanding. Do not pad.",
  "- Use only what the conversation says. Invent no facts, no dates, no commitments and no cause.",
  "- If the thread is unclear or contradictory, say so rather than resolving it yourself.",
  "- Do not address the student and do not suggest a reply. You are describing the ticket to a colleague.",
  "- Plain text, British English, at most 120 words excluding any labels.",
].join("\n");

/**
 * Summarise a ticket, freshly, every time it is asked.
 *
 * Throws rather than returning a failure, so the route stays two lines: a 404 if
 * the ticket is gone (`getTicket`), a 503 if this server has no API key
 * (`openAiModel`), a 502 if the provider failed or answered with something
 * unusable.
 */
export async function summarizeTicket(ticketId: number): Promise<string> {
  const ticket = await getTicket(ticketId);

  // Nothing to summarise, and a model given an empty thread would invent one.
  // Not reachable through the inbound path, which creates a ticket and its first
  // message together, but it is reachable in principle and the honest answer is
  // cheaper than a guess.
  if (ticket.messages.length === 0) {
    throw new HttpError(400, "There are no messages on this ticket to summarise.");
  }

  const summary = await askModel(buildPrompt(ticket));

  if (summary.length > MAX_SUMMARY_LENGTH) {
    throw new HttpError(502, "The summary came back too long to use. Please try again.");
  }
  return summary;
}

/** The ticket's own facts, then the conversation. */
function buildPrompt(ticket: PublicTicketDetail): string {
  return [
    `Subject: ${ticket.subject}`,
    `Student: ${ticket.requesterName}`,
    `Status: ${ticket.status}`,
    `Opened: ${ticket.createdAt.toISOString()}`,
    `Messages on the ticket: ${ticket.messageCount}`,
    "",
    "Conversation, oldest first:",
    renderThread(ticket.messages),
  ].join("\n");
}

/**
 * The conversation, each message labelled with who sent it and when. The date
 * matters here in a way it does not when polishing: "what is still outstanding"
 * usually turns on how long ago the last thing happened.
 */
function renderThread(messages: PublicMessage[]): string {
  return messages
    .slice(-CONTEXT_MESSAGES)
    .map((message) => {
      const who = message.direction === MessageDirection.INBOUND ? "Student" : "Agent";
      const when = message.createdAt.toISOString();
      return `${who} (${message.fromName}, ${when}):\n${truncate(message.body, CONTEXT_BODY_LENGTH)}`;
    })
    .join("\n\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * The provider call, and the one place its failures become something an agent can
 * read. The same treatment the polisher gives them: one 502 with one sentence,
 * the real error logged rather than returned - it can carry the prompt back,
 * which here is the whole conversation.
 */
async function askModel(input: string): Promise<string> {
  let text: string;

  try {
    const result = await generateText({
      model: openAiModel(),
      instructions: INSTRUCTIONS,
      prompt: input,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      providerOptions: {
        openai: {
          reasoningEffort: "low",
          textVerbosity: "low",
          // Do not let OpenAI retain this. A summary prompt is the entire
          // conversation, so it carries more of a student's own words than any
          // other call in the system - and `tech-stack.md` still lists
          // third-party LLMs and student data as an open question.
          store: false,
        },
      },
    });
    text = result.text;
  } catch (err) {
    if (err instanceof HttpError) throw err;

    console.error("Ticket summarising failed:", err);
    throw new HttpError(502, "Could not summarise the ticket just now. Please try again.");
  }

  const summary = text.trim();
  // An empty answer is a failure that did not throw. Shown as-is it would read as
  // "this ticket has nothing in it", which is a claim the model never made.
  if (summary.length === 0) {
    throw new HttpError(502, "The model returned an empty summary. Please try again.");
  }
  return summary;
}
