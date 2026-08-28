import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { REPO_ROOT } from "./launch.js";

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

export interface FixtureAppProcess {
  origin: string;
  stop(): Promise<void>;
}

export async function spawnFixtureApp(): Promise<FixtureAppProcess> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(
    "node",
    ["--import", "tsx", join(REPO_ROOT, "apps/fixture-app/src/main.ts")],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FIXTURE_PORT: String(port),
      },
    },
  );
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`${origin}/`);
      if (response.ok) break;
    } catch {
      if (child.exitCode !== null) {
        throw new Error(`fixture app exited ${String(child.exitCode)}\n${stderr.join("")}`);
      }
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`fixture app did not start\n${stderr.join("")}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }

  return {
    origin,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => {
        child.on("exit", resolveExit);
        setTimeout(resolveExit, 3_000);
      });
    },
  };
}
