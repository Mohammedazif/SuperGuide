import {
  apiErrorSchema,
  chatAcceptedSchema,
  productConfigSchema,
  sessionResponseSchema,
  toolResultAcceptedSchema,
  type ChatAccepted,
  type ChatRequest,
  type ConfirmRequest,
  type PageDigest,
  type ProductConfig,
  type SessionResponse,
  type ToolResultPayload,
  type CapabilityDescriptor,
} from "@superguide/contract/public";

export interface TransportOptions {
  apiUrl: string;
  productId: string;
  fetchImplementation?: typeof fetch;
}

export type TransportResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

function failure(status: number, code: string, message: string): TransportResult<never> {
  return { ok: false, status, code, message };
}

export class Transport {
  readonly #options: TransportOptions;
  #sessionToken: string | null = null;

  constructor(options: TransportOptions) {
    this.#options = options;
  }

  get sessionToken(): string | null {
    return this.#sessionToken;
  }

  setSessionToken(token: string | null): void {
    this.#sessionToken = token;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-sg-product-id": this.#options.productId,
      ...(this.#sessionToken === null ? {} : { authorization: `Bearer ${this.#sessionToken}` }),
      ...extra,
    };
  }

  url(path: string): string {
    return new URL(path, this.#options.apiUrl).toString();
  }

  get fetch(): typeof fetch {
    return this.#options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
  }

  async #send<T>(
    path: string,
    body: unknown,
    parse: (value: unknown) => T,
    options: { method?: string; keepalive?: boolean } = {},
  ): Promise<TransportResult<T>> {
    let response: Response;
    try {
      response = await this.fetch(this.url(path), {
        method: options.method ?? "POST",
        headers: this.headers(),
        body: body === undefined ? null : JSON.stringify(body),
        ...(options.keepalive === true ? { keepalive: true } : {}),
      });
    } catch (error) {
      return failure(0, "network_unreachable", error instanceof Error ? error.message : "offline");
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(payload);
      return failure(
        response.status,
        parsed.success ? parsed.data.error.code : "internal_error",
        parsed.success ? parsed.data.error.message : `request failed with ${String(response.status)}`,
      );
    }

    try {
      return { ok: true, value: parse(payload) };
    } catch (error) {
      return failure(
        response.status,
        "payload_invalid",
        error instanceof Error ? error.message : "the reply did not match the contract",
      );
    }
  }

  openSession(): Promise<TransportResult<SessionResponse>> {
    return this.#send(
      "/v1/session",
      { productId: this.#options.productId },
      (value) => sessionResponseSchema.parse(value),
    );
  }

  identify(token: string): Promise<TransportResult<SessionResponse>> {
    return this.#send("/v1/identify", { token }, (value) => sessionResponseSchema.parse(value));
  }

  config(): Promise<TransportResult<ProductConfig>> {
    return this.#send(
      `/v1/products/${this.#options.productId}/config`,
      undefined,
      (value) => productConfigSchema.parse(value),
      { method: "GET" },
    );
  }

  registerCapabilities(
    capabilities: CapabilityDescriptor[],
  ): Promise<TransportResult<{ registered: string[]; awaitingReview: string[] }>> {
    return this.#send("/v1/capabilities", { capabilities }, (value) => {
      const record = value as { registered?: string[]; awaitingReview?: string[] };
      return { registered: record.registered ?? [], awaitingReview: record.awaitingReview ?? [] };
    });
  }

  chat(request: ChatRequest): Promise<TransportResult<ChatAccepted>> {
    return this.#send("/v1/chat", request, (value) => chatAcceptedSchema.parse(value));
  }

  toolResult(
    conversationId: string,
    toolCallId: string,
    result: ToolResultPayload,
    options: { keepalive?: boolean } = {},
  ): Promise<TransportResult<{ status: string }>> {
    return this.#send(
      "/v1/tool-result",
      { conversationId, toolCallId, result },
      (value) => toolResultAcceptedSchema.parse(value),
      options.keepalive === true ? { keepalive: true } : {},
    );
  }

  confirm(request: ConfirmRequest): Promise<TransportResult<{ status: string }>> {
    return this.#send("/v1/confirm", request, (value) => value as { status: string });
  }

  cancel(turnId: string): Promise<TransportResult<{ status: string }>> {
    return this.#send(`/v1/turns/${turnId}/cancel`, undefined, (value) => value as { status: string });
  }

  digestOrNull(digest: PageDigest | null): PageDigest | null {
    return digest;
  }
}
