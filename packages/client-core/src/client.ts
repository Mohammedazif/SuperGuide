import type {
  ConfirmationDecision,
  ConversationSummary,
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
  conversations: ConversationSummary[];
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
  // Closed shadow root: host hears sg: events; widget content stays inside.
  onNotify?: (name: string, detail: Record<string, unknown>) => void;
}

export const SESSION_NAMESPACE = "session";
export const CONVERSATION_NAMESPACE = "conversation";

interface StoredSession {
  token: string;
  expiresAt: string;
  tier: string;
  scopes: string[];
}

function emptyState(): ClientState {
  return {
    status: "idle",
    conversationId: null,
    turnId: null,
    running: false,
    messages: [],
    conversations: [],
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
  #queuedMessage: string | null = null;
  #pendingUserIds = new Set<string>();

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
        this.#forgetConversation();
        this.#patch({
          running: false,
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

  // Session and conversation survive navigation so the same user and owed results come back.
  #restoreSession(): boolean {
    const stored = this.#options.storage.read<StoredSession>(SESSION_NAMESPACE, "current");
    if (stored === null) return false;
    if (Date.parse(stored.expiresAt) <= Date.now()) return false;
    this.#options.transport.setSessionToken(stored.token);
    return true;
  }

  #forgetConversation(): void {
    this.#stream.stop();
    this.#options.storage.remove(CONVERSATION_NAMESPACE, "current");
    this.#patch({ conversationId: null, turnId: null });
  }

  async start(): Promise<void> {
    this.#patch({ status: "opening" });

    const restored = this.#restoreSession();
    if (!restored) {
      const session = await this.#options.transport.openSession();
      if (!session.ok) {
        // The widget fails closed: a control plane outage leaves the host page untouched.
        this.#options.onLog?.("session could not be opened", session);
        this.#patch({ status: "unavailable" });
        return;
      }
      this.#options.transport.setSessionToken(session.value.sessionToken);
      this.#options.storage.write(
        SESSION_NAMESPACE,
        "current",
        {
          token: session.value.sessionToken,
          expiresAt: session.value.expiresAt,
          tier: session.value.tier,
          scopes: session.value.scopes,
        },
        Math.max(0, Date.parse(session.value.expiresAt) - Date.now()),
      );
      // A new anonymous user cannot resume another user's conversation id.
      this.#forgetConversation();
    }

    const config = await this.#options.transport.config();
    this.#patch({
      status: "ready",
      config: config.ok ? config.value : null,
    });
    await this.refreshHistory();

    const carried = this.#options.storage.read<string>(CONVERSATION_NAMESPACE, "current");
    if (carried !== null) await this.openConversation(carried);

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

    const queued = this.#queuedMessage;
    if (queued !== null) {
      this.#queuedMessage = null;
      await this.send(queued);
    }
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
    this.#options.storage.write(
      SESSION_NAMESPACE,
      "current",
      {
        token: result.value.sessionToken,
        expiresAt: result.value.expiresAt,
        tier: result.value.tier,
        scopes: result.value.scopes,
      },
      Math.max(0, Date.parse(result.value.expiresAt) - Date.now()),
    );
    return true;
  }

  async send(message: string): Promise<void> {
    if (this.#state.status === "opening" || this.#state.status === "idle") {
      this.#queuedMessage = message;
      return;
    }
    if (this.#state.status !== "ready") return;

    const optimisticId = crypto.randomUUID();
    this.#pendingUserIds.add(optimisticId);
    const optimistic = {
      id: optimisticId,
      seq: (this.#state.messages.at(-1)?.seq ?? 0) + 1,
      role: "user" as const,
      content: { text: message },
      createdAt: new Date().toISOString(),
    };
    this.#patch({
      running: true,
      streamingText: "",
      notice: null,
      escalation: null,
      messages: [...this.#state.messages, optimistic],
    });

    const payload = {
      message,
      digest: this.#options.currentDigest(),
      url: this.#options.currentUrl(),
    };
    let accepted = await this.#options.transport.chat({
      conversationId: this.#state.conversationId,
      ...payload,
    });

    if (!accepted.ok && accepted.code === "conversation_unknown") {
      this.#forgetConversation();
      accepted = await this.#options.transport.chat({ conversationId: null, ...payload });
    }

    if (!accepted.ok) {
      this.#pendingUserIds.delete(optimisticId);
      this.#patch({
        running: false,
        messages: this.#state.messages.filter((entry) => entry.id !== optimisticId),
        notice:
          accepted.code === "rate_limited"
            ? "That was a lot of requests at once. Give it a moment and try again."
            : "That could not be sent. Nothing was changed.",
      });
      return;
    }

    const first = this.#state.conversationId === null;
    this.#options.storage.write(CONVERSATION_NAMESPACE, "current", accepted.value.conversationId);
    this.#patch({ conversationId: accepted.value.conversationId, turnId: accepted.value.turnId });
    if (first) this.#stream.connect(accepted.value.conversationId);
    void this.refreshHistory();
  }

  async refreshHistory(): Promise<void> {
    const listed = await this.#options.transport.listConversations();
    if (listed.ok) this.#patch({ conversations: listed.value.conversations });
  }

  newChat(): void {
    if (this.#state.turnId !== null) {
      void this.#options.transport.cancel(this.#state.turnId);
    }
    this.#stream.stop();
    this.#options.storage.remove(CONVERSATION_NAMESPACE, "current");
    this.#pendingUserIds.clear();
    this.#patch({
      conversationId: null,
      turnId: null,
      running: false,
      messages: [],
      streamingText: "",
      confirmation: null,
      escalation: null,
      notice: null,
    });
  }

  async openConversation(conversationId: string): Promise<void> {
    if (this.#state.running) return;
    const detail = await this.#options.transport.getConversation(conversationId);
    if (!detail.ok) {
      if (detail.code === "conversation_unknown") {
        this.#forgetConversation();
        await this.refreshHistory();
        return;
      }
      this.#options.storage.write(CONVERSATION_NAMESPACE, "current", conversationId);
      this.#patch({ conversationId, messages: [], notice: null });
      this.#stream.connect(conversationId);
      return;
    }
    this.#stream.stop();
    this.#options.storage.write(CONVERSATION_NAMESPACE, "current", conversationId);
    this.#patch({
      conversationId,
      turnId: null,
      messages: detail.value.messages,
      streamingText: "",
      confirmation: null,
      escalation: null,
      notice: null,
      running: false,
    });
    this.#stream.connect(conversationId);
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
    this.#pendingUserIds.clear();
    this.#options.storage.remove(CONVERSATION_NAMESPACE, "current");
    this.#stream.stop();
    this.#state = {
      ...emptyState(),
      status: this.#state.status,
      config: this.#state.config,
      conversations: this.#state.conversations,
    };
    for (const listener of [...this.#listeners]) listener(this.#state);
  }

  #handleEvent(event: SgEvent): void {
    switch (event.event) {
      case "turn.started":
        this.#patch({ running: true, turnId: event.turnId, streamingText: "" });
        this.#options.onNotify?.("turn-started", { turnId: event.turnId });
        return;

      case "message.delta":
        this.#patch({ streamingText: this.#state.streamingText + event.text });
        return;

      case "message.completed": {
        const seen = this.#state.messages.some((message) => message.id === event.message.id);
        if (seen) return;
        const pendingMatch = this.#state.messages.find(
          (entry) =>
            this.#pendingUserIds.has(entry.id) &&
            entry.role === event.message.role &&
            entry.content.text === event.message.content.text,
        );
        if (pendingMatch !== undefined) {
          this.#pendingUserIds.delete(pendingMatch.id);
          this.#patch({
            messages: this.#state.messages
              .map((entry) => (entry.id === pendingMatch.id ? event.message : entry))
              .sort((left, right) => left.seq - right.seq),
            streamingText: "",
          });
        } else {
          this.#patch({
            messages: [...this.#state.messages, event.message].sort(
              (left, right) => left.seq - right.seq,
            ),
            streamingText: "",
          });
        }
        this.#options.onNotify?.("message", {
          role: event.message.role,
          seq: event.message.seq,
          text: event.message.content.text,
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
        this.#options.onNotify?.("confirm", {
          toolCallId: event.toolCallId,
          preview: event.preview,
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
        this.#options.onNotify?.("escalation", { reason: event.reason, message: event.userMessage });
        return;

      case "turn.finished":
        this.#patch({ running: false, turnId: null, streamingText: "" });
        this.#options.onNotify?.("turn-finished", {
          turnId: event.turnId,
          resolutionState: event.resolutionState,
          summary: event.summary,
        });
        return;

      case "turn.failed":
        this.#options.onNotify?.("turn-failed", { code: event.code });
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
