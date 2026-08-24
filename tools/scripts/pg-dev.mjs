import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIR = join(REPO_ROOT, ".pgdata");
const PORT = 55432;
const SUPERUSER = "postgres";
const DATABASE = "superguide";

const PG_HOME = process.env.SG_PG_HOME ?? join(process.env.HOME ?? "", ".local/superguide-pg16");
const BIN = join(PG_HOME, "bin");

function bin(name) {
  return join(BIN, name);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
    env: { ...process.env, PGPASSWORD: "postgres", ...(options.env ?? {}) },
  });
  if (result.error) throw result.error;
  return result;
}

function mustRun(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function psql(sql, { database = DATABASE, user = SUPERUSER } = {}) {
  return mustRun(bin("psql"), [
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    "127.0.0.1",
    "-p",
    String(PORT),
    "-U",
    user,
    "-d",
    database,
    "-c",
    sql,
  ]);
}

function isRunning() {
  const result = run(bin("pg_ctl"), ["-D", DATA_DIR, "status"]);
  return result.status === 0;
}

function waitReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = run(bin("pg_isready"), ["-h", "127.0.0.1", "-p", String(PORT)]);
    if (result.status === 0) return;
    spawnSync("sleep", ["0.5"]);
  }
  throw new Error("postgres did not become ready");
}

function initCluster() {
  const pwfile = join(REPO_ROOT, ".pginitpw");
  writeFileSync(pwfile, "postgres\n", { mode: 0o600 });
  mustRun(bin("initdb"), [
    "-D",
    DATA_DIR,
    "-U",
    SUPERUSER,
    "--auth-local=trust",
    "--auth-host=scram-sha-256",
    `--pwfile=${pwfile}`,
    "--encoding=UTF8",
    "--no-sync",
  ]);
  rmSync(pwfile);
}

function start() {
  if (!existsSync(join(DATA_DIR, "PG_VERSION"))) initCluster();
  if (isRunning()) {
    console.log(`postgres already running on ${PORT}`);
    return;
  }
  mustRun(bin("pg_ctl"), [
    "-D",
    DATA_DIR,
    "-l",
    join(DATA_DIR, "server.log"),
    "-o",
    `-p ${PORT} -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off`,
    "-w",
    "start",
  ]);
  waitReady();
  bootstrap();
  console.log(`postgres 16 ready on 127.0.0.1:${PORT}`);
}

function bootstrap() {
  const exists = mustRun(bin("psql"), [
    "-tA",
    "-h",
    "127.0.0.1",
    "-p",
    String(PORT),
    "-U",
    SUPERUSER,
    "-d",
    "postgres",
    "-c",
    `SELECT 1 FROM pg_database WHERE datname = '${DATABASE}'`,
  ]).stdout.trim();
  if (exists !== "1") {
    psql(`CREATE DATABASE ${DATABASE}`, { database: "postgres" });
  }
  mustRun(bin("psql"), [
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    "127.0.0.1",
    "-p",
    String(PORT),
    "-U",
    SUPERUSER,
    "-d",
    DATABASE,
    "-f",
    join(REPO_ROOT, "tools/scripts/bootstrap-roles.sql"),
  ]);
  psql("CREATE EXTENSION IF NOT EXISTS vector");
}

function stop() {
  if (!isRunning()) {
    console.log("postgres not running");
    return;
  }
  mustRun(bin("pg_ctl"), ["-D", DATA_DIR, "-m", "fast", "-w", "stop"]);
  console.log("postgres stopped");
}

function reset() {
  if (isRunning()) stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
  start();
}

function main() {
  if (!existsSync(bin("postgres"))) {
    console.error(
      `No local PostgreSQL at ${PG_HOME}. Use docker compose up -d instead, or set SG_PG_HOME.`,
    );
    process.exit(1);
  }
  const command = process.argv[2] ?? "start";
  switch (command) {
    case "start":
      start();
      break;
    case "stop":
      stop();
      break;
    case "reset":
      reset();
      break;
    case "status":
      console.log(isRunning() ? "running" : "stopped");
      break;
    default:
      console.error(`unknown command: ${command}`);
      process.exit(1);
  }
}

main();
