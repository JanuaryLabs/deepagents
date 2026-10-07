import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import {
  JSONRPCErrorCode,
  JSONRPCErrorException,
  type JSONRPCRequest,
  JSONRPCServer,
  createJSONRPCErrorResponse,
  isJSONRPCRequest,
} from 'json-rpc-2.0';

import {
  FileIndexCache,
  Text2Sql,
  Text2SqlUnknownAdapterError,
  Text2SqlUnknownDatabaseError,
  Text2SqlValidationError,
} from '@deepagents/text2sql';

import adapters, { pool } from './demo-adapters.ts';

const PORT = Number(process.env.PORT ?? '4747');
const VALIDATION_ERROR_CODE = -32000;

const cacheDir = process.env.TEXT2SQL_INDEX_CACHE_DIR;
const cacheNamespace = process.env.TEXT2SQL_INDEX_VERSION;

const text2Sql = new Text2Sql({
  adapters,
  cache:
    cacheDir || cacheNamespace
      ? new FileIndexCache({ dir: cacheDir, namespace: cacheNamespace })
      : undefined,
});

const adapterNames = text2Sql.adapterNames();
console.log(
  `[daemon] loaded ${adapterNames.length} adapter${
    adapterNames.length === 1 ? '' : 's'
  }: ${adapterNames.join(', ')}`,
);

function requireString(
  obj: Record<string, unknown>,
  key: string,
  method: string,
): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new JSONRPCErrorException(
      `${method}: "${key}" must be a non-empty string`,
      JSONRPCErrorCode.InvalidParams,
    );
  }
  return value;
}

function asObject(params: unknown, method: string): Record<string, unknown> {
  if (params == null) return {};
  if (!isRecord(params)) {
    throw new JSONRPCErrorException(
      `${method}: params must be an object`,
      JSONRPCErrorCode.InvalidParams,
    );
  }
  return params;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((n) => typeof n === 'string');
}

/** One request or a batch. `isJSONRPCRequest` reads properties, so it only gets objects. */
function isRequestPayload(
  value: unknown,
): value is JSONRPCRequest | JSONRPCRequest[] {
  const isRequest = (item: unknown) => isRecord(item) && isJSONRPCRequest(item);
  return Array.isArray(value) ? value.every(isRequest) : isRequest(value);
}

const server = new JSONRPCServer({
  errorListener: () => {},
});

server.addMethod('text2sql.adapters', () => ({
  adapters: text2Sql.adapterNames(),
}));

server.addMethod('text2sql.validate', async (params) => {
  const obj = asObject(params, 'text2sql.validate');
  const db = requireString(obj, 'db', 'text2sql.validate');
  const sql = requireString(obj, 'sql', 'text2sql.validate');
  const name = text2Sql.resolveAdapterName(db);
  return { sql: await text2Sql.validate(name, sql) };
});

server.addMethod('text2sql.run', async (params) => {
  const obj = asObject(params, 'text2sql.run');
  const db = requireString(obj, 'db', 'text2sql.run');
  const sql = requireString(obj, 'sql', 'text2sql.run');
  const name = text2Sql.resolveAdapterName(db);
  return text2Sql.run(name, sql);
});

server.addMethod('text2sql.index', async (params) => {
  const obj = asObject(params, 'text2sql.index');
  const names = obj.names;
  if (names !== undefined && !isStringArray(names)) {
    throw new JSONRPCErrorException(
      'text2sql.index: "names" must be an array of strings',
      JSONRPCErrorCode.InvalidParams,
    );
  }
  const resolvedNames = names ?? text2Sql.adapterNames();
  const emitEvents = obj.emitEvents === true;
  const events: unknown[] = [];
  const fragments = await text2Sql.index({
    names: resolvedNames,
    onProgress: emitEvents ? (event) => events.push(event) : undefined,
  });
  return emitEvents
    ? { fragments, resolvedNames, events }
    : { fragments, resolvedNames };
});

server.applyMiddleware(async (next, request, context) => {
  const started = performance.now();
  try {
    const response = await next(request, context);
    const ms = (performance.now() - started).toFixed(1);
    if (response && 'error' in response && response.error) {
      console.log(
        `[rpc] ${request.method} (${ms}ms) err: ${response.error.message}`,
      );
    } else {
      console.log(`[rpc] ${request.method} (${ms}ms) ok`);
    }
    return response;
  } catch (error) {
    const ms = (performance.now() - started).toFixed(1);
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`[rpc] ${request.method} (${ms}ms) err: ${detail}`);
    if (error instanceof JSONRPCErrorException) throw error;
    if (Text2SqlValidationError.isInstance(error)) {
      throw new JSONRPCErrorException(error.message, VALIDATION_ERROR_CODE);
    }
    if (Text2SqlUnknownDatabaseError.isInstance(error)) {
      throw new JSONRPCErrorException(
        error.message,
        JSONRPCErrorCode.InvalidParams,
        { requested: error.requested, available: error.available },
      );
    }
    if (Text2SqlUnknownAdapterError.isInstance(error)) {
      throw new JSONRPCErrorException(
        error.message,
        JSONRPCErrorCode.InvalidParams,
        { adapter: error.adapter, available: error.available },
      );
    }
    throw new JSONRPCErrorException(detail, JSONRPCErrorCode.InternalError);
  }
});

const app = new Hono();
app.use(logger());

app.get('/health', (c) =>
  c.json({ ok: true, adapters: text2Sql.adapterNames() }),
);

app.post('/rpc', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      createJSONRPCErrorResponse(
        null,
        JSONRPCErrorCode.ParseError,
        'invalid JSON',
      ),
      400,
    );
  }
  if (!isRequestPayload(body)) {
    return c.json(
      createJSONRPCErrorResponse(
        null,
        JSONRPCErrorCode.InvalidRequest,
        'invalid request',
      ),
      400,
    );
  }
  const response = await server.receive(body);
  return response == null ? c.body(null, 204) : c.json(response);
});

const httpServer = serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`[daemon] listening on http://127.0.0.1:${port} (POST /rpc)`);
});

/** Closes the server and the pool, then exits; a later signal joins the first shutdown. */
class Shutdown {
  #closing: Promise<void> | undefined;

  run(signal: NodeJS.Signals): Promise<void> {
    this.#closing ??= this.#close(signal);
    return this.#closing;
  }

  async #close(signal: NodeJS.Signals) {
    console.log(`[daemon] ${signal} received, shutting down`);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await pool.end().catch((err: Error) => {
      console.log(`[daemon] pool.end() failed: ${err.message}`);
    });
    process.exit(0);
  }
}

const shutdown = new Shutdown();
process.once('SIGINT', () => void shutdown.run('SIGINT'));
process.once('SIGTERM', () => void shutdown.run('SIGTERM'));
