import type { Identity, PageDigest } from "@superguide/contract/public";

export interface TurnStartInput {
  productId: string;
  conversationId: string;
  turnId: string;
  identity: Identity;
  userMessage: string;
  digest: PageDigest | null;
  url: string;
  requestId: string;
}

export interface TurnRunner {
  start(input: TurnStartInput): void;
  cancel(turnId: string): boolean;
  activeTurnCount(): number;
  drain(timeoutMs: number): Promise<void>;
}
