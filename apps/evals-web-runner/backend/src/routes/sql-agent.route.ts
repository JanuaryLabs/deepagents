import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import mssql from 'mssql';
import { z } from 'zod';

import type { ContextFragment } from '@deepagents/context';
import { toSql } from '@deepagents/text2sql';
import sqlserver, { type SqlServer } from '@deepagents/text2sql/sqlserver';

import { validate } from '../middlewares/validator.ts';
import { resolveModel } from '../services/model-resolver.ts';
import type { AppBindings } from '../store.ts';

function parseMssqlConfig(connectionString: string): string | mssql.config {
  if (!connectionString.startsWith('sqlserver://')) {
    return connectionString;
  }

  const withoutScheme = connectionString.slice('sqlserver://'.length);
  const segments = withoutScheme.split(';').filter(Boolean);
  const server = segments[0] ?? '';

  const params: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const eqIdx = segment.indexOf('=');
    if (eqIdx === -1) continue;
    const key = segment.slice(0, eqIdx).trim().toLowerCase();
    let value = segment.slice(eqIdx + 1).trim();
    if (value.startsWith('{') && value.endsWith('}')) {
      value = value.slice(1, -1);
    }
    params[key] = value;
  }

  return {
    server,
    user: params['user'] ?? params['user id'],
    password: params['password'],
    database: params['database'] ?? params['initial catalog'],
    options: {
      encrypt: (params['encrypt'] ?? 'true') === 'true',
      trustServerCertificate: params['trustservercertificate'] === 'true',
    },
  };
}

interface SqlAgentContext {
  adapter: SqlServer;
  fragments: ContextFragment[];
}

let cached: Promise<SqlAgentContext> | null = null;

function getOrCreateContext(): Promise<SqlAgentContext> {
  if (cached) return cached;

  cached = (async () => {
    const connectionString = process.env['MSSQL_CONNECTION_STRING'];
    if (!connectionString) {
      throw new Error(
        'MSSQL_CONNECTION_STRING environment variable is not configured.',
      );
    }

    console.log('[sql-agent] Connecting to MSSQL...');
    const pool = await mssql.connect(parseMssqlConfig(connectionString));
    console.log('[sql-agent] Connected to MSSQL');

    const adapter = new sqlserver.SqlServer({
      grounding: [
        sqlserver.info(),
        sqlserver.tables(),
        sqlserver.views(),
        sqlserver.constraints(),
      ],
      execute: async (sql: string) => {
        const result = await pool.request().query(sql);
        return result.recordset;
      },
    });

    console.log('[sql-agent] Introspecting schema...');
    const fragments = await adapter.introspect();
    console.log(
      '[sql-agent] Schema introspected, fragments:',
      fragments.length,
    );

    return { adapter, fragments };
  })();

  cached.catch(() => {
    cached = null;
  });

  return cached;
}

export default function (router: Hono<AppBindings>) {
  router.post(
    '/sql-agent',
    validate((payload) => ({
      input: {
        select: payload.body.input,
        against: z.string().min(1).trim(),
      },
      model: {
        select: payload.body.model,
        against: z.string().trim().optional(),
      },
    })),
    async (c) => {
      const { input, model: modelString } = c.var.input;
      console.log('[sql-agent] Request received:', {
        input: input.substring(0, 80),
        model: modelString,
      });

      const { adapter, fragments } = await getOrCreateContext();

      const model = modelString
        ? resolveModel(modelString)
        : resolveModel('groq/gpt-oss-20b');

      console.log('[sql-agent] Calling toSql...');
      const result = await toSql({
        input,
        adapter,
        fragments,
        model,
      });
      console.log('[sql-agent] SQL generated:', result.sql.substring(0, 100));

      return c.json({ output: result.sql });
    },
  );
}
