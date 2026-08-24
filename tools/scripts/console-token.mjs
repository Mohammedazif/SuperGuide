import { createHmac } from "node:crypto";

const [, , operatorEmail, tenantId, hoursRaw] = process.argv;
const hours = Number(hoursRaw ?? "8");

if (operatorEmail === undefined || tenantId === undefined) {
  console.error("usage: node tools/scripts/console-token.mjs <operator-email> <tenant-id> [hours]");
  process.exit(1);
}

const key = process.env.SG_SESSION_SIGNING_KEY;
if (key === undefined) {
  console.error("SG_SESSION_SIGNING_KEY must be set");
  process.exit(1);
}

const issuedAt = Math.floor(Date.now() / 1000);
const claims = {
  operatorEmail,
  tenantId,
  issuedAt,
  expiresAt: issuedAt + Math.round(hours * 3600),
};

const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
const body = `sgc1.${payload}`;
const signature = createHmac("sha256", Buffer.from(key, "base64")).update(body).digest("base64url");

console.log(`${body}.${signature}`);
console.log(`\nSet it as a cookie:\n  sg_console=<token>; Path=/internal; HttpOnly; SameSite=Strict`);
