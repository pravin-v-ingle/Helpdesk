/**
 * Unit tests for the OpenAI client wrapper.
 *
 * `env.ts` reads `process.env` once at import time and this module is the only
 * thing in the system that cares whether `OPENAI_API_KEY` is set, so the tests
 * move `env.openai` instead - see `test/fakes.ts`, which owns that
 * substitution and hands back the *real* `openAiModel` captured before
 * `lib/ai.ts` is itself faked for everything downstream.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { openaiEnv, realOpenAiModel, resetFakes } from "../test/fakes.ts";
import { HttpError } from "../middleware/error-handler.ts";

describe("openAiModel", () => {
  beforeEach(resetFakes);

  /**
   * The whole reason the key is optional in `env.ts`: a deployment that never
   * wanted the AI features still boots, and only those buttons fail - with a
   * sentence written for the agent who pressed one rather than a 500. One message
   * for both features, since the agent knows which button they pressed.
   */
  it("refuses with a 503 when no API key is configured", () => {
    expect(() => realOpenAiModel()).toThrow(HttpError);

    try {
      realOpenAiModel();
    } catch (err) {
      const { status, message } = err as HttpError;
      expect(status).toBe(503);
      expect(message).toBe("AI features are not configured on this server.");
    }
  });

  it("builds a model on the OpenAI responses API once a key is configured", () => {
    openaiEnv.apiKey = "sk-unit-test";

    const model = realOpenAiModel();
    expect(model.provider).toBe("openai.responses");
    expect(model.modelId).toBe("gpt-5-nano");
    // The model interface the service's `generateText` call is typed against; a
    // provider upgrade that moved past v4 would land here first.
    expect(model.specificationVersion).toBe("v4");
  });

  /**
   * A model id is the one setting here that goes stale on somebody else's
   * schedule, which is why `OPENAI_MODEL` exists at all.
   */
  it("uses the configured model id", () => {
    openaiEnv.apiKey = "sk-unit-test";
    openaiEnv.model = "gpt-5-mini";

    expect(realOpenAiModel().modelId).toBe("gpt-5-mini");
  });

  /**
   * The provider is cached but the guard is not: the key is checked on every
   * call, so an earlier success cannot leave the 503 bypassed. Worth pinning,
   * because `provider ??=` sitting right beside the check makes "cache the whole
   * thing" the easy mistake to make here later.
   */
  it("checks the key on every call, not only the first", () => {
    openaiEnv.apiKey = "sk-unit-test";
    expect(realOpenAiModel().modelId).toBe("gpt-5-nano");

    openaiEnv.apiKey = undefined;
    expect(() => realOpenAiModel()).toThrow("AI features are not configured on this server.");
  });
});
