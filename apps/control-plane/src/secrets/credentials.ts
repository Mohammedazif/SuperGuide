import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export const apiCredentialsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("bearer"), token: z.string().min(1) }),
  z.object({ kind: z.literal("header"), name: z.string().min(1), value: z.string().min(1) }),
  z.object({
    kind: z.literal("basic"),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
]);
export type ApiCredentials = z.infer<typeof apiCredentialsSchema>;

export interface SealedCredentials {
  ciphertext: Buffer;
  iv: Buffer;
}

export function sealCredentials(key: Buffer, credentials: ApiCredentials): SealedCredentials {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), iv };
}

export interface RequestSigner {
  applyTo(headers: Headers): void;
  secretValues(): readonly string[];
}

class NoCredentialsSigner implements RequestSigner {
  applyTo(): void {
    return;
  }
  secretValues(): readonly string[] {
    return [];
  }
}

// Plaintext credential is closed over here; nothing returns it to logs or trajectory.
class SealedCredentialsSigner implements RequestSigner {
  readonly #apply: (headers: Headers) => void;
  readonly #secrets: readonly string[];

  constructor(credentials: ApiCredentials) {
    switch (credentials.kind) {
      case "none":
        this.#apply = () => undefined;
        this.#secrets = [];
        break;
      case "bearer": {
        const value = `Bearer ${credentials.token}`;
        this.#apply = (headers) => {
          headers.set("authorization", value);
        };
        this.#secrets = [credentials.token, value];
        break;
      }
      case "header": {
        const { name, value } = credentials;
        this.#apply = (headers) => {
          headers.set(name.toLowerCase(), value);
        };
        this.#secrets = [value];
        break;
      }
      case "basic": {
        const encoded = Buffer.from(
          `${credentials.username}:${credentials.password}`,
          "utf8",
        ).toString("base64");
        const value = `Basic ${encoded}`;
        this.#apply = (headers) => {
          headers.set("authorization", value);
        };
        this.#secrets = [credentials.password, encoded, value];
        break;
      }
      default: {
        const exhaustive: never = credentials;
        throw new Error(`unhandled credential kind: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  applyTo(headers: Headers): void {
    this.#apply(headers);
  }

  secretValues(): readonly string[] {
    return this.#secrets;
  }
}

export function createRequestSigner(
  key: Buffer,
  sealed: SealedCredentials | null,
): RequestSigner {
  if (sealed === null) return new NoCredentialsSigner();

  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  const parsed = apiCredentialsSchema.safeParse(JSON.parse(plaintext));
  if (!parsed.success) throw new Error("stored api credentials failed validation");

  return new SealedCredentialsSigner(parsed.data);
}
