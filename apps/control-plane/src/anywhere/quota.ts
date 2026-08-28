import { createHash } from "node:crypto";
import type pg from "pg";
import type { Quota } from "@superguide/contract/anywhere";
import type { Environment } from "../env.js";

export function utcDayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function resetsAtOf(now: Date): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.toISOString();
}

export function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

export class QuotaService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly env: Environment,
  ) {}

  async deviceQuota(deviceId: string, now: Date): Promise<Quota> {
    const result = await this.pool.query<{ used: number; quota_override: number | null }>(
      `SELECT COALESCE(u.used, 0) AS used, d.quota_override
       FROM device d
       LEFT JOIN device_usage u ON u.device_id = d.id AND u.day = $2
       WHERE d.id = $1`,
      [deviceId, utcDayOf(now)],
    );
    const row = result.rows[0];
    const limit = row?.quota_override ?? this.env.SG_DAILY_TASK_QUOTA;
    return { used: row?.used ?? 0, limit, resetsAt: resetsAtOf(now) };
  }

  async recordCompletedTask(deviceId: string, now: Date, client: pg.PoolClient): Promise<void> {
    await client.query(
      `INSERT INTO device_usage (device_id, day, used) VALUES ($1, $2, 1)
       ON CONFLICT (device_id, day) DO UPDATE SET used = device_usage.used + 1`,
      [deviceId, utcDayOf(now)],
    );
  }

  async bumpIpTaskCount(ip: string, now: Date): Promise<number> {
    const result = await this.pool.query<{ used: number }>(
      `INSERT INTO ip_usage (ip_hash, day, used) VALUES ($1, $2, 1)
       ON CONFLICT (ip_hash, day) DO UPDATE SET used = ip_usage.used + 1
       RETURNING used`,
      [hashIp(ip, this.env.SG_DEVICE_SIGNING_KEY), utcDayOf(now)],
    );
    return result.rows[0]?.used ?? 1;
  }

  async bumpIpRegistrations(ip: string, now: Date): Promise<number> {
    const result = await this.pool.query<{ registrations: number }>(
      `INSERT INTO ip_usage (ip_hash, day, registrations) VALUES ($1, $2, 1)
       ON CONFLICT (ip_hash, day) DO UPDATE SET registrations = ip_usage.registrations + 1
       RETURNING registrations`,
      [hashIp(ip, this.env.SG_DEVICE_SIGNING_KEY), utcDayOf(now)],
    );
    return result.rows[0]?.registrations ?? 1;
  }
}
