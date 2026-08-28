import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { REPO_ROOT, EXTENSION_ID } from "./launch.js";

async function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((error) => {
        if (error) rejectPort(error);
        else resolvePort(port);
      });
    });
  });
}

export function appDatabaseUrl(): string {
  const fromEnv = process.env["SG_DATABASE_URL"];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return "postgres://sg_app:sg_app_dev@127.0.0.1:55432/superguide";
}

export interface ControlPlaneProcess {
  baseUrl: string;
  port: number;
  databaseUrl: string;
  stop(): Promise<void>;
}

export async function spawnControlPlane(
  options: {
    agentLoop?: "on" | "off";
    adapters?: "on" | "off";
    port?: number;
    dailyTaskQuota?: string;
  } = {},
): Promise<ControlPlaneProcess> {
  const port = options.port ?? (await freePort());
  const baseUrl = `http://localhost:${port}`;
  const databaseUrl = appDatabaseUrl();
  const key = randomBytes(32).toString("base64");
  const child: ChildProcess = spawn(
    "node",
    ["--import", "tsx", join(REPO_ROOT, "apps/control-plane/src/main.ts")],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SG_DATABASE_URL: databaseUrl,
        SG_PORT: String(port),
        SG_PUBLIC_ORIGIN: baseUrl,
        SG_MODEL_PROVIDER: process.env["SG_MODEL_PROVIDER"] ?? "anthropic",
        ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] ?? "unused-in-transport-e2e",
        OPENAI_API_KEY: process.env["OPENAI_API_KEY"] ?? "",
        GEMINI_API_KEY: process.env["GEMINI_API_KEY"] ?? "",
        SG_SESSION_SIGNING_KEY: key,
        SG_SECRET_ENCRYPTION_KEY: key,
        SG_WEBHOOK_SIGNING_KEY: key,
        SG_DEVICE_SIGNING_KEY: key,
        SG_ALLOWED_EXTENSION_IDS: `chrome-extension://${EXTENSION_ID}`,
        SG_LOG_LEVEL: "warn",
        SG_ANYWHERE_AGENT: options.agentLoop ?? "off",
        SG_ADAPTERS: options.adapters ?? "on",
        SG_ENABLE_GROUNDED_ACTIONS: "false",
        ...(options.dailyTaskQuota === undefined
          ? {}
          : { SG_DAILY_TASK_QUOTA: options.dailyTaskQuota }),
      },
    },
  );
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/v1/anywhere/quota`);
      if (response.status === 403) break;
    } catch {
      if (child.exitCode !== null) {
        throw new Error(`control plane exited ${child.exitCode}\n${stderr.join("")}`);
      }
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`control plane did not start\n${stderr.join("")}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }

  return {
    baseUrl,
    port,
    databaseUrl,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => {
        child.on("exit", resolveExit);
        setTimeout(resolveExit, 3_000);
      });
    },
  };
}
