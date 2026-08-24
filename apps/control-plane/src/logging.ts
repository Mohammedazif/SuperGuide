import { pino, type Logger } from "pino";
import type { Environment } from "./env.js";

export type AppLogger = Logger;

export function createLogger(env: Pick<Environment, "SG_LOG_LEVEL">): AppLogger {
  return pino({
    level: env.SG_LOG_LEVEL,
    base: { service: "superguide-control-plane" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers['set-cookie']",
        "*.sessionToken",
        "*.token",
        "*.apiCredentials",
      ],
      censor: "[redacted]",
    },
  });
}
