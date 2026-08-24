export interface SseFrame {
  id: number | null;
  event: string;
  data: unknown;
}

export interface SseReader {
  frames: SseFrame[];
  waitFor(predicate: (frames: SseFrame[]) => boolean, timeoutMs?: number): Promise<void>;
  close(): void;
  closed: Promise<void>;
}

export async function openSse(
  url: string,
  headers: Record<string, string>,
): Promise<SseReader> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  if (!response.ok || response.body === null) {
    throw new Error(`stream did not open: ${response.status} ${await response.text()}`);
  }

  const frames: SseFrame[] = [];
  const waiters: { predicate: (frames: SseFrame[]) => boolean; resolve: () => void }[] = [];

  const notify = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter !== undefined && waiter.predicate(frames)) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  const closed = (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");

          if (block.startsWith(":")) continue;
          let id: number | null = null;
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) id = Number(line.slice(4));
            else if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (data.length > 0) {
            frames.push({ id, event, data: JSON.parse(data) });
            notify();
          }
        }
      }
    } catch {
      // The reader ends when the connection is aborted; recorded frames stay valid.
    }
  })();

  return {
    frames,
    waitFor(predicate, timeoutMs = 10_000) {
      if (predicate(frames)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `timed out waiting for frames; saw ${JSON.stringify(frames.map((f) => [f.id, f.event]))}`,
            ),
          );
        }, timeoutMs);
        timer.unref();
        waiters.push({
          predicate,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
    close() {
      controller.abort();
    },
    closed,
  };
}
