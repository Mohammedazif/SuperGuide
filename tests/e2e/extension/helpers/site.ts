import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureSite {
  origin: string;
  close(): Promise<void>;
}

export async function startSite(hostname: string, html: string): Promise<FixtureSite> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, resolveListen);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${hostname}:${port}`,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      }),
  };
}
