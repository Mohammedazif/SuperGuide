import type { SgEvent } from "@superguide/contract/public";

export type EphemeralHandler = (event: SgEvent) => void;

export class EphemeralBus {
  readonly #handlers = new Map<string, Set<EphemeralHandler>>();

  subscribe(conversationId: string, handler: EphemeralHandler): () => void {
    const existing = this.#handlers.get(conversationId);
    if (existing === undefined) {
      this.#handlers.set(conversationId, new Set([handler]));
    } else {
      existing.add(handler);
    }
    return () => {
      const handlers = this.#handlers.get(conversationId);
      if (handlers === undefined) return;
      handlers.delete(handler);
      if (handlers.size === 0) this.#handlers.delete(conversationId);
    };
  }

  publish(conversationId: string, event: SgEvent): void {
    const handlers = this.#handlers.get(conversationId);
    if (handlers === undefined) return;
    for (const handler of [...handlers]) handler(event);
  }

  subscriberCount(conversationId: string): number {
    return this.#handlers.get(conversationId)?.size ?? 0;
  }
}
