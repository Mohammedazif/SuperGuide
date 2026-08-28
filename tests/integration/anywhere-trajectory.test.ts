import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { appDatabaseUrl, migrationDatabaseUrl } from "../helpers/database.js";

describe("anywhere trajectory is append-only", () => {
  let app: pg.Client;
  let migrator: pg.Client;
  const turnId = randomUUID();

  beforeAll(async () => {
    app = new pg.Client({ connectionString: appDatabaseUrl() });
    migrator = new pg.Client({ connectionString: migrationDatabaseUrl() });
    await app.connect();
    await migrator.connect();

    const deviceId = randomUUID();
    await app.query("INSERT INTO device (id) VALUES ($1)", [deviceId]);
    await app.query(
      "INSERT INTO turn (id, device_id, origin, tier, task_text, status) VALUES ($1, $2, $3, $4, $5, $6)",
      [turnId, deviceId, "https://app.example.com", "observe", "a task", "running"],
    );
    await app.query("INSERT INTO trajectory (turn_id, seq, kind, payload) VALUES ($1, 0, $2, $3)", [
      turnId,
      "task-received",
      JSON.stringify({ note: "first step" }),
    ]);
  });

  afterAll(async () => {
    await app.end();
    await migrator.end();
  });

  it("rejects a direct UPDATE on the trajectory, whoever asks", async () => {
    await expect(
      app.query("UPDATE trajectory SET kind = 'report' WHERE turn_id = $1", [turnId]),
    ).rejects.toThrow(/append-only|denied/);
    await expect(
      migrator.query("UPDATE trajectory SET kind = 'report' WHERE turn_id = $1", [turnId]),
    ).rejects.toThrow("trajectory is append-only");
  });

  it("rejects DELETE and TRUNCATE as well", async () => {
    await expect(
      migrator.query("DELETE FROM trajectory WHERE turn_id = $1", [turnId]),
    ).rejects.toThrow("trajectory is append-only");
    await expect(migrator.query("TRUNCATE trajectory")).rejects.toThrow("trajectory is append-only");
  });

  it("refuses a second step reusing a sequence number", async () => {
    await expect(
      app.query("INSERT INTO trajectory (turn_id, seq, kind, payload) VALUES ($1, 0, $2, $3)", [
        turnId,
        "task-received",
        JSON.stringify({ note: "duplicate" }),
      ]),
    ).rejects.toThrow(/duplicate key/);
  });

  it("denies the app role UPDATE by grant, before the trigger even fires", async () => {
    const rows = await app.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'sg_app' AND table_name = 'trajectory'`,
    );
    expect(rows.rows.map((row) => row.privilege_type).sort()).toEqual(["INSERT", "SELECT"]);
  });
});
