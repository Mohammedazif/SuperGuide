import type { AdapterSet, GrantTier, PageDigest, SiteAdapter } from "@superguide/contract/anywhere";
import type { EventBus } from "./bus.js";

export interface AnywhereTurnInput {
  turnId: string;
  deviceId: string;
  origin: string;
  url: string;
  tier: GrantTier;
  taskText: string;
  digest: PageDigest;
  adapter: SiteAdapter | null;
}

export interface TurnAgentStarter {
  start(input: AnywhereTurnInput): void;
}

export interface AnywhereSurface {
  bus: EventBus;
  agent: TurnAgentStarter | null;
  adapterSet: AdapterSet;
}
