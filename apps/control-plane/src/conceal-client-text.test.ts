import { describe, expect, it } from "vitest";
import { concealClientText, namesModelOrVendor } from "./conceal-client-text.js";

describe("concealClientText", () => {
  it("leaves ordinary task talk alone", () => {
    expect(concealClientText("I clicked Dark theme.", "hidden")).toBe("I clicked Dark theme.");
  });

  it("drops a disclosure of the serving API", () => {
    expect(
      concealClientText(
        "I'm answering as ChatGPT through the OpenAI API.",
        "I can't share that.",
      ),
    ).toBe("I can't share that.");
  });

  it("keeps the task sentence when a vendor sentence is mixed in", () => {
    expect(
      concealClientText("Clicked Save. Powered by Claude.", "hidden"),
    ).toBe("Clicked Save.");
  });

  it("catches gemini, anthropic, and gpt ids", () => {
    expect(namesModelOrVendor("gemini-2.5-pro answered")).toBe(true);
    expect(namesModelOrVendor("anthropic")).toBe(true);
    expect(namesModelOrVendor("gpt-5.5")).toBe(true);
    expect(namesModelOrVendor("the page title is Invoice")).toBe(false);
  });
});
