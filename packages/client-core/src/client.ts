import type {
  ConfirmationDecision,
  DurableMessage,
  PageDigest,
  ProductConfig,
  SgEvent,
} from "@superguide/contract/public";
import type { ActionExecutor } from "@superguide/executor";
import type { CapabilityDefinition, ClientCapabilityRegistry } from "./capabilities.js";
import { ToolDispatcher } from "./dispatcher.js";
import { ConversationStreamClient } from "./stream.js";
import type { NamespacedStorage } from "./storage.js";
import type { Transport } from "./transport.js";

export interface PendingConfirmation {
  toolCallId: string;
  paramsHash: string;
  preview: string;
  expiresAt: string;
}

export interface ClientState {
  status: "idle" | "opening" | "ready" | "unavailable";
  conversationId: string | null;
  turnId: string | null;
  running: boolean;
  messages: DurableMessage[];
  streamingText: string;
  confirmation: PendingConfirmation | null;
  escalation: { reason: string; message: string; referenceUrl: string } | null;
  notice: string | null;
  config: ProductConfig | null;
}

export type StateListener = (state: ClientState) => void;

export interface ClientOptions {
  transport: Transport;
  executor: ActionExecutor;
  storage: NamespacedStorage;
  capabilities: ClientCapabilityRegistry;
  currentDigest: () => PageDigest | null;
  currentUrl: () => string;
  onLog?: (message: string, detail?: unknown) => void;
}

function emptyState(): ClientState {
  return {
    status: "idle",
    conversationId: null,
    turnId: null,
    running: false,
    messages: [],
    streamingText: "",
    confirmation: null,
    escalation: null,
    notice: null,
    config: null,
  };
}

export class SuperGuideClient {
  readonly #options: ClientOptions;
  readonly #dispatcher: ToolDispatcher;
  readonly #stream: ConversationStreamClient;
  readonly #listeners = new Set<StateListener>();
  #state: ClientState = emptyState();

  constructor(options: ClientOptions) {
    this.#options = options;

    this.#dispatcher = new ToolDispatcher({
      transport: options.transport,
      storage: options.storage,
      executor: options.executor,
      currentUrl: options.currentUrl,
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
    });

    this.#stream = new ConversationStreamClient(options.transport, {
      onEvent: (event) => {
        this.#handleEvent(event);
      },
      onGone: () => {
        this.#patch({
          running: false,
          turnId: null,
          notice: "That request is no longer running. You can ask again.",
        });
      },
      onError: (detail) => {
        options.onLog?.("stream error", detail);
      },
    });
  }

  get state(): ClientState {
    return this.#state;
  }

  subscribe(listener: StateListener): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  #patch(partial: Partial<ClientState>): void {
    this.#state = { ...this.#state, ...partial };
    for (const listener of [...this.#listeners]) listener(this.#state);
  }

  async start(): Promise<void> {
    this.#patch({ status: "opening" });

    const session = await this.#options.transport.openSession();
    if (!session.ok) {
      // The widget fails closed: a control plane outage leaves the host page untouched.
      this.#options.onLog?.("session could not be opened", session);
      this.#patch({ status: "unavailable" });
      return;
    }
    this.#options.transport.setSessionToken(session.value.sessionToken);

    const config = await this.#options.transport.config();
    this.#patch({
      status: "ready",
      config: config.ok ? config.value : null,
    });

    const descriptors = this.#options.capabilities.descriptors();
    if (descriptors.length > 0) {
      const registered = await this.#options.transport.registerCapabilities(descriptors);
      if (!registered.ok) this.#options.onLog?.("capabilities were not registered", registered);
      else if (registered.value.awaitingReview.length > 0) {
        this.#options.onLog?.("capabilities awaiting review", registered.value.awaitingReview);
      }
    }

    const replayed = await this.#dispatcher.replayPending(this.#options.currentDigest());
    if (replayed > 0) this.#options.onLog?.("replayed pending results", replayed);
  }

  registerCapabilities(definitions: readonly CapabilityDefinition[]): void {
    const outcome = this.#options.capabilities.register(definitions);
    for (const rejection of outcome.rejected) {
      this.#options.onLog?.("a capability was rejected", rejection);
    }
  }

  async identify(token: string): Promise<boolean> {
    const result = await this.#options.transport.identify(token);
    if (!result.ok) {
      this.#options.onLog?.("identify was refused", result);
      return false;
    }
    this.#options.transport.setSessionToken(result.value.sessionToken);
    return true;
  }

  async send(message: string): Promise<void> {
    if (this.#state.status !== "ready") return;

    this.#patch({ running: true, streamingText: "", notice: null, escalation: null });

    const accepted = await this.#options.transport.chat({
      conversationId: this.#state.conversationId,
      message,
      digest: this.#options.currentDigest(),
      url: this.#options.currentUrl(),
    });

    if (!accepted.ok) {
      this.#patch({
        running: false,
        notice:
          accepted.code === "rate_limited"
            ? "That was a lot of requests at once. Give it a moment and try again."
            : "That could not be sent. Nothing was changed.",
      });
      return;
    }

    const first = this.#state.conversationId === null;
    this.#patch({ conversationId: accepted.value.conversationId, turnId: accepted.value.turnId });
    if (first) this.#stream.connect(accepted.value.conversationId);
  }

  async decideConfirmation(decision: ConfirmationDecision): Promise<void> {
    const pending = this.#state.confirmation;
    const conversationId = this.#state.conversationId;
    if (pending === null || conversationId === null) return;

    this.#patch({ confirmation: null });
    const result = await this.#options.transport.confirm({
      conversationId,
      toolCallId: pending.toolCallId,
      paramsHash: pending.paramsHash,
      decision,
    });

    if (!result.ok) {
      this.#patch({ notice: "That decision could not be recorded, so nothing was done." });
    }
  }

  async cancel(): Promise<void> {
    const turnId = this.#state.turnId;
    if (turnId === null) return;
    await this.#options.transport.cancel(turnId);
  }

  reportNavigation(): void {
    this.#dispatcher.reportInterruptedByNavigation();
  }

  reconnect(): void {
    this.#stream.reconnectNow();
  }

  stop(): void {
    this.#stream.stop();
  }

  reset(): void {
    this.#stream.stop();
    this.#state = { ...emptyState(), status: this.#state.status, config: this.#state.config };
    for (const listener of [...this.#listeners]) listener(this.#state);
  }

  #handleEvent(event: SgEvent): void {
    switch (event.event) {
      case "turn.started":
        this.#patch({ running: true, turnId: event.turnId, streamingText: "" });
        return;

      case "message.delta":
        this.#patch({ streamingText: this.#state.streamingText + event.text });
        return;

      case "message.completed": {
        const seen = this.#state.messages.some((message) => message.id === event.message.id);
        if (seen) return;
        this.#patch({
          messages: [...this.#state.messages, event.message].sort((left, right) => left.seq - right.seq),
          streamingText: "",
        });
        return;
      }

      case "action.confirm":
        this.#patch({
          confirmation: {
            toolCallId: event.toolCallId,
            paramsHash: event.paramsHash,
            preview: event.preview,
            expiresAt: event.expiresAt,
          },
        });
        return;

      case "action.executing": {
        const conversationId = this.#state.conversationId;
        if (conversationId === null) return;
        void this.#dispatcher.dispatch(conversationId, event.action);
        return;
      }

      case "action.result":
      case "step.recorded":
        return;

      case "escalation.created":
        this.#patch({
          escalation: {
            reason: event.reason,
            message: event.userMessage,
            referenceUrl: event.referenceUrl,
          },
        });
        return;

      case "turn.finished":
        this.#patch({ running: false, turnId: null, streamingText: "" });
        return;

      case "turn.failed":
        this.#patch({
          running: false,
          turnId: null,
          streamingText: "",
          notice:
            event.code === "server_shutdown"
              ? "The connection dropped. Reconnecting."
              : "Something went wrong and this did not finish.",
        });
        if (event.code === "server_shutdown") this.#stream.reconnectNow();
        return;

      default: {
        const exhaustive: never = event;
        throw new Error(`unhandled event: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}
