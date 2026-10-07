/**
 * The OpenAI client, shared by the two AI features built so far: polishing an
 * agent's draft reply (`services/polish-reply.ts`) and summarising a ticket
 * (`services/summarize-ticket.ts`).
 *
 * Everything else about AI in this system is Anthropic's - `tech-stack.md`
 * records the decision and this exception to it. The Vercel AI SDK is the client
 * rather than `openai` itself, so the provider behind these calls is a one-line
 * change if the model ever moves.
 *
 * The provider is built on first use rather than at import time, for the same
 * reason the key is optional in `env.ts`: a deployment that never configured one
 * should still boot, and should fail only when somebody presses a button.
 */
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { env } from "../env.ts";
import { HttpError } from "../middleware/error-handler.ts";

let provider: OpenAIProvider | undefined;

/**
 * The model both features ask, or a 503 if this server has no key.
 *
 * 503 rather than 500: nothing has gone wrong, the feature is simply not
 * configured here, and the message is one a page can show an agent as it arrives
 * - they need to know the button will not work rather than that "an error
 * occurred". One sentence covering both features, because the agent knows which
 * button they pressed and a message per caller would be two strings saying the
 * same thing.
 */
export function openAiModel() {
  const { apiKey, model } = env.openai;
  if (!apiKey) {
    throw new HttpError(503, "AI features are not configured on this server.");
  }

  // `??=` and not a module-level call: an unconfigured server never builds one.
  // The guard above is deliberately outside the cache - the key is checked on
  // every call, so an earlier success cannot leave the 503 bypassed.
  provider ??= createOpenAI({ apiKey });
  return provider(model);
}
