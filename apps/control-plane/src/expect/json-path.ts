export type JsonPathSegment =
  | { kind: "key"; name: string }
  | { kind: "index"; position: number }
  | { kind: "wildcard" };

export type JsonPathParse =
  | { ok: true; segments: JsonPathSegment[] }
  | { ok: false; reason: string };

export function parseJsonPath(path: string): JsonPathParse {
  if (!path.startsWith("$")) return { ok: false, reason: "a path must start with $" };

  const segments: JsonPathSegment[] = [];
  let cursor = 1;

  while (cursor < path.length) {
    const character = path[cursor];

    if (character === ".") {
      cursor += 1;
      const start = cursor;
      while (cursor < path.length && /[A-Za-z0-9_-]/.test(path[cursor] ?? "")) cursor += 1;
      if (cursor === start) return { ok: false, reason: `empty key at position ${String(start)}` };
      segments.push({ kind: "key", name: path.slice(start, cursor) });
      continue;
    }

    if (character === "[") {
      const close = path.indexOf("]", cursor);
      if (close === -1) return { ok: false, reason: "unclosed bracket" };
      const inner = path.slice(cursor + 1, close);
      cursor = close + 1;

      if (inner === "*") {
        segments.push({ kind: "wildcard" });
      } else if (/^-?\d+$/.test(inner)) {
        segments.push({ kind: "index", position: Number(inner) });
      } else if (/^"[^"]*"$/.test(inner) || /^'[^']*'$/.test(inner)) {
        segments.push({ kind: "key", name: inner.slice(1, -1) });
      } else {
        return { ok: false, reason: `unsupported bracket expression ${inner}` };
      }
      continue;
    }

    return { ok: false, reason: `unexpected character ${String(character)}` };
  }

  return { ok: true, segments };
}

export function queryJsonPath(root: unknown, path: string): { ok: true; values: unknown[] } | { ok: false; reason: string } {
  const parsed = parseJsonPath(path);
  if (!parsed.ok) return parsed;

  let current: unknown[] = [root];

  for (const segment of parsed.segments) {
    const next: unknown[] = [];
    for (const value of current) {
      switch (segment.kind) {
        case "key": {
          if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            const record = value as Record<string, unknown>;
            if (Object.hasOwn(record, segment.name)) next.push(record[segment.name]);
          }
          break;
        }
        case "index": {
          if (Array.isArray(value)) {
            const position = segment.position < 0 ? value.length + segment.position : segment.position;
            if (position >= 0 && position < value.length) next.push(value[position]);
          }
          break;
        }
        case "wildcard": {
          if (Array.isArray(value)) next.push(...(value as unknown[]));
          else if (typeof value === "object" && value !== null) {
            next.push(...Object.values(value as Record<string, unknown>));
          }
          break;
        }
        default: {
          const exhaustive: never = segment;
          throw new Error(`unhandled segment: ${JSON.stringify(exhaustive)}`);
        }
      }
    }
    current = next;
  }

  return { ok: true, values: current };
}
