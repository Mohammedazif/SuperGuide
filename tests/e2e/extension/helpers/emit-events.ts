import pg from "pg";
import { TurnStore } from "../../../../apps/control-plane/src/anywhere/store.js";
import { appDatabaseUrl } from "./control-plane-process.js";

const [turnId, countRaw, startRaw] = process.argv.slice(2);
if (turnId === undefined || countRaw === undefined) {
  process.stderr.write("usage: emit-events.ts <turnId> <count> [startIndex]\n");
  process.exit(2);
}
const count = Number(countRaw);
const start = Number(startRaw ?? "0");
const pool = new pg.Pool({ connectionString: appDatabaseUrl() });
const store = new TurnStore(pool);
for (let index = 0; index < count; index += 1) {
  await store.appendEvent(turnId, { kind: "assistant-text", text: `event ${start + index}` });
}
await pool.end();
