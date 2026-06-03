import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import {
  JSONRPCErrorCode,
  JSONRPCErrorException,
  JSONRPCServer,
  createJSONRPCErrorResponse,
} from 'json-rpc-2.0';

import {
  FileIndexCache,
  Text2Sql,
  Text2SqlUnknownAdapterError,
  Text2SqlValidationError,
} from '@deepagents/text2sql';

import adapters, { pool } from './demo-adapters.ts';
import { PgAdvisoryIndexLock } from './pg-advisory-lock.ts';

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
  lock: new PgAdvisoryIndexLock(pool),
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
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new JSONRPCErrorException(
      `${method}: params must be an object`,
      JSONRPCErrorCode.InvalidParams,
    );
  }
  return params as Record<string, unknown>;
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
  return { sql: await text2Sql.validate(db, sql) };
});

server.addMethod('text2sql.run', async (params) => {
  const obj = asObject(params, 'text2sql.run');
  const db = requireString(obj, 'db', 'text2sql.run');
  const sql = requireString(obj, 'sql', 'text2sql.run');
  return text2Sql.run(db, sql);
});

server.addMethod('text2sql.index', async (params) => {
  const obj = asObject(params, 'text2sql.index');
  const names = obj.names;
  if (names !== undefined) {
    if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) {
      throw new JSONRPCErrorException(
        'text2sql.index: "names" must be an array of strings',
        JSONRPCErrorCode.InvalidParams,
      );
    }
  }
  const requested = names as string[] | undefined;
  const resolvedNames = requested ?? text2Sql.adapterNames();
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
  const response = await server.receive(body as never);
  return response == null ? c.body(null, 204) : c.json(response);
});

const httpServer = serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`[daemon] listening on http://127.0.0.1:${port} (POST /rpc)`);
});

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[daemon] ${signal} received, shutting down`);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await pool.end().catch((err: Error) => {
    console.log(`[daemon] pool.end() failed: ${err.message}`);
  });
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
