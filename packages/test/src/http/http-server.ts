import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type RequestListener, type Server, createServer } from 'node:http';

export interface HttpServerHandle extends AsyncDisposable {
  origin: string;
  server: Server;
  /** Stop accepting requests and close active HTTP connections. */
  cleanup: () => Promise<void>;
}

/** Each acquisition owns a loopback HTTP server on an available port. */
export class HttpServer {
  async start(handler: RequestListener): Promise<HttpServerHandle> {
    await using resources = new AsyncDisposableStack();
    const server = createServer(handler);
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;

    resources.defer(async () => {
      const closed = server[Symbol.asyncDispose]();
      server.closeAllConnections();
      await closed;
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    const owned = resources.move();
    const cleanup = () => owned.disposeAsync();

    return {
      origin: `http://127.0.0.1:${address.port}`,
      server,
      cleanup,
      [Symbol.asyncDispose]: cleanup,
    };
  }
}
