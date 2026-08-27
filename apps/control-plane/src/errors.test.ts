import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { TurnFailure, describeError, publicFailureMessage } from "./errors.js";
import { describeModelError } from "./model/client.js";

/**
 * A provider error carries the upstream response body in its own message. It
 * is attached as a cause so it reaches the logs, and must not travel any
 * further than that: turn.failed is a public event a browser can read off the
 * wire, so the model behind the product would otherwise be named in it.
 */
function providerError(): InstanceType<typeof Anthropic.APIError> {
  return new Anthropic.APIError(
    404,
    { type: "error", error: { type: "not_found_error", message: "model: claude-opus-5" } },
    undefined,
    new Headers(),
  );
}

describe("publicFailureMessage", () => {
  it("does not walk the cause chain of a wrapped provider error", () => {
    const failure = describeModelError(providerError());

    expect(failure).toBeInstanceOf(TurnFailure);
    expect(publicFailureMessage(failure)).toBe("the model provider returned status 404");
    expect(publicFailureMessage(failure)).not.toMatch(/claude|anthropic/i);
  });

  it("keeps the cause available to describeError, which is log only", () => {
    const failure = describeModelError(providerError());

    expect(describeError(failure)).toContain("claude-opus-5");
  });

  it("replaces the message of anything that is not a TurnFailure", () => {
    expect(publicFailureMessage(providerError())).toBe("The turn could not be completed.");
    expect(publicFailureMessage(new Error("connect ECONNREFUSED 10.0.0.4:443"))).toBe(
      "The turn could not be completed.",
    );
    expect(publicFailureMessage("raw string")).toBe("The turn could not be completed.");
  });

  it("passes an authored TurnFailure message through unchanged", () => {
    const failure = new TurnFailure(
      "model_rate_limited",
      "the model provider is rate limiting requests",
    );

    expect(publicFailureMessage(failure)).toBe("the model provider is rate limiting requests");
  });
});
