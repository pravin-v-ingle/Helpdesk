/**
 * Rewriting an agent's draft reply into something worth sending.
 *
 * The one AI feature in the system so far, and deliberately the smallest useful
 * shape of one: text in, text out, nothing stored. The draft is not saved, the
 * polished version is not saved, and nothing is sent anywhere - the agent gets
 * the rewrite back in the textarea they typed in, reads it, and decides. Which
 * is what makes this safe to ship ahead of the AI in Phase 5: a model that
 * writes badly here costs an agent one press of Undo.
 *
 * Why it hangs off a ticket id rather than being a free-standing "improve this
 * text" endpoint: the thread is the context. A reply rewritten without the
 * question it answers loses the requester's name, the problem and the register
 * the conversation is already in, and reads like a form letter. The thread is
 * read, never written.
 */
import { MAX_REPLY_LENGTH } from "@helpdesk/core/schemas/tickets";
import { generateText } from "ai";
import { MessageDirection } from "../generated/prisma/enums.ts";
import { openAiModel } from "../lib/ai.ts";
import { HttpError } from "../middleware/error-handler.ts";
import {
  getTicket,
  type PublicMessage,
  type PublicTicketDetail,
} from "./tickets.ts";

/**
 * How much of the thread the model is shown. Both numbers are about cost and
 * latency rather than correctness: `gpt-5-nano` would take the whole thread, but
 * an agent waiting on a button wants an answer in a second or two, and the tail
 * of a conversation is what a reply is answering anyway.
 */
const CONTEXT_MESSAGES = 6;
const CONTEXT_BODY_LENGTH = 2_000;

/**
 * The ceiling on what comes back. Generous for a support reply, and low enough
 * that a model which ignores its instructions and starts writing an essay is cut
 * off rather than billed for.
 */
const MAX_OUTPUT_TOKENS = 2_000;

/**
 * How long the provider gets. An agent is sitting in front of this button, so a
 * provider having a bad day has to become an error message quickly rather than
 * holding an Express request open until something else gives up.
 */
const TIMEOUT_MS = 30_000;

/**
 * What the model is for, and - more to the point - what it is not for. The three
 * prohibitions are the ones that would turn a convenience into a liability:
 * inventing facts puts a promise in an agent's name that nobody made, answering
 * the student instead of rewriting the draft replaces the agent's judgement with
 * the model's, and wrapping the result in commentary ("Here is a polished
 * version:") means the agent has to edit the output of the thing that was
 * supposed to save them editing.
 */
const INSTRUCTIONS = [
  "You are an editor for a tech ed company's helpdesk-support team.",
  "You rewrite a support agent's draft reply so that it reads clearly and kindly.",
  "",
  "Rules:",
  "- Return only the rewritten reply. No preamble, no commentary, no quotes around it, no markdown fences.",
  "- Keep every fact, number, date, link, name and commitment exactly as the draft has them. Add none of your own.",
  "- Do not answer the student yourself, and do not add information the draft does not contain. If the draft is vague, leave it vague.",
  "- Keep the draft's meaning and its decisions. You are changing the wording, not the answer.",
  "- Write plain British English, warm and direct, in short paragraphs. Fix spelling, grammar and punctuation.",
  "- Keep it roughly the length of the draft, and never more than twice it.",
  "- Plain text only: no markdown, no headings, and no bullet characters unless the draft already used them.",
].join("\n");

/**
 * Hand the draft back rewritten.
 *
 * Throws rather than returning a failure, so the route stays three lines: a 404
 * if the ticket is gone (`getTicket`), a 503 if this server has no API key
 * (`openAiModel`), a 502 if the provider failed or answered with something
 * unusable.
 */
export async function polishReply(
  ticketId: number,
  draft: string,
): Promise<string> {
  // Before the provider call, not after: there is no sense paying for a rewrite
  // of a draft on a ticket that does not exist, and a 404 is the honest answer.
  const ticket = await getTicket(ticketId);

  const polished = await askModel(buildPrompt(ticket, draft));

  // The rewrite goes back into the composer's textarea, which validates with
  // `ticketReplySchema` - so one longer than the schema allows would be a
  // response the form then refuses, with nothing on screen to say why. Said
  // plainly here instead. The instructions ask for roughly the draft's length,
  // so this is a backstop rather than an expected path.
  if (polished.length > MAX_REPLY_LENGTH) {
    throw new HttpError(
      502,
      "The polished reply came back too long to use. Please try again.",
    );
  }
  return polished;
}

/**
 * The prompt: the thread as context, then the draft, each in a labelled block.
 *
 * The draft comes last and is labelled as the thing to rewrite, because that is
 * the instruction a model follows most reliably. It is still untrusted text as
 * far as the instructions go - but a draft saying "ignore the above" is a prompt
 * injection an agent typed at themselves, and it costs them a bad rewrite and
 * nothing more: the output is text in a textarea, never a command, and nothing
 * downstream executes, stores or sends it.
 */
function buildPrompt(ticket: PublicTicketDetail, draft: string): string {
  return [
    `Support ticket subject: ${ticket.subject}`,
    `The student who wrote in: ${ticket.requesterName}`,
    "",
    "Conversation so far, oldest first:",
    renderThread(ticket.messages),
    "",
    "The agent's draft reply to rewrite:",
    draft,
  ].join("\n");
}

/** The tail of the thread, each message labelled with who said it. */
function renderThread(messages: PublicMessage[]): string {
  if (messages.length === 0) return "(no messages yet)";

  return messages
    .slice(-CONTEXT_MESSAGES)
    .map((message) => {
      const who =
        message.direction === MessageDirection.INBOUND ? "Student" : "Agent";
      return `${who} (${message.fromName}): ${truncate(message.body, CONTEXT_BODY_LENGTH)}`;
    })
    .join("\n\n");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * The provider call, and the one place its failures become something an agent
 * can read.
 *
 * Any error from the SDK - a rejected key, a rate limit, the timeout above, a
 * model id that no longer exists - becomes one 502 with one sentence. The real
 * error is logged rather than returned: it can carry the request body back,
 * which is a student's own message, and a stack trace is no use to the person
 * looking at the composer.
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
          // Copy-editing, not reasoning: `low` effort is what keeps the button
          // fast enough to press, and `low` verbosity stops a nano model padding
          // a three-line reply into five paragraphs.
          reasoningEffort: "low",
          textVerbosity: "low",
          // Do not let OpenAI retain this. The prompt carries a student's own
          // words, and `tech-stack.md` still lists whether their data may go to
          // a third-party model as an open question - the least this can do
          // while that is open is leave no copy behind.
          store: false,
        },
      },
    });
    text = result.text;
  } catch (err) {
    // The 503 from `openAiModel` is deliberate and already says the right
    // thing, so it is not swallowed into the generic failure below.
    if (err instanceof HttpError) throw err;

    console.error("Reply polishing failed:", err);
    throw new HttpError(
      502,
      "Could not polish the reply just now. Please try again.",
    );
  }

  const polished = text.trim();
  // An empty answer is a failure that did not throw: a refusal, a response that
  // was all reasoning tokens, a stop before the first word. Returning it would
  // wipe the agent's draft, which is the one outcome this feature must not have.
  if (polished.length === 0) {
    throw new HttpError(
      502,
      "The model returned an empty reply. Please try again.",
    );
  }
  return polished;
}
