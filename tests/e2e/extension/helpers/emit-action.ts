import { randomUUID } from "node:crypto";
import pg from "pg";
import { paramsHashOf, type AgentAction } from "@superguide/contract/anywhere";
import { TurnStore } from "../../../../apps/control-plane/src/anywhere/store.js";
import { appDatabaseUrl } from "./control-plane-process.js";

const [turnId, path] = process.argv.slice(2);
if (turnId === undefined || path === undefined) {
  process.stderr.write("usage: emit-action.ts <turnId> <path>\n");
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: appDatabaseUrl() });
const store = new TurnStore(pool);
const action: AgentAction = { kind: "navigate", path };
const actionId = randomUUID();
await store.appendEvent(turnId, {
  kind: "action-request",
  actionId,
  action,
  risk: "read",
  expect: [],
  paramsHash: await paramsHashOf(action),
  needsConfirmation: false,
  summary: `Navigate to ${path}`,
});
process.stdout.write(`${actionId}\n`);
await pool.end();
