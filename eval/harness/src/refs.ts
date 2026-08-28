import type { PageDigest } from "@superguide/contract/public";
import type { GenerateRequest, GenerateResult, ModelClient } from "@superguide/control-plane";

const PLACEHOLDER = /\{\{ref:([^}]+)\}\}/g;

// Transcripts name elements; observer refs are minted at runtime and resolved from the live digest.
export class RefResolvingModelClient implements ModelClient {
  readonly #inner: ModelClient;
  readonly #digest: () => PageDigest;

  constructor(inner: ModelClient, digest: () => PageDigest) {
    this.#inner = inner;
    this.#digest = digest;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const result = await this.#inner.generate(request);
    const byName = new Map(this.#digest().elements.map((element) => [element.name, element.ref]));

    for (const block of result.message.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input as Record<string, unknown>;
      for (const [key, value] of Object.entries(input)) {
        if (typeof value !== "string") continue;
        input[key] = value.replace(PLACEHOLDER, (whole, name: string) => byName.get(name) ?? whole);
      }
    }
    return result;
  }

  classify: ModelClient["classify"] = (request) => this.#inner.classify(request);
}
