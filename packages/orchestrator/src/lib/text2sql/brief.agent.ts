import { groq } from '@ai-sdk/groq';
import { createUIMessageStream, tool } from 'ai';
import dedent from 'dedent';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import z from 'zod';

import { agent, generate, user } from '@deepagents/agent';

import type { StreamFunction } from '../pipe.ts';
import db from './db.ts';
import { inspector } from './introspector.ts';

class BriefCache {
  public path: string;
  constructor(watermark: string) {
    const hash = createHash('md5').update(watermark).digest('hex');
    this.path = path.join(tmpdir(), `db-brief-${hash}.txt`);
  }

  async get() {
    if (existsSync(this.path)) {
      return readFile(this.path, 'utf-8');
    }
    return null;
  }

  set(brief: string) {
    return writeFile(this.path, brief, 'utf-8');
  }
}

const briefAgent = agent<
  unknown,
  {
    schema: ReturnType<typeof inspector>;
  }
>({
  name: 'db-brief-agent',
  model: groq('openai/gpt-oss-20b'),
  prompt: (state) => dedent`
    <identity>
      You are a database analyst expert. Your job is to understand what a database represents and provide business context about it.
      You have READ-ONLY access to the database.
    </identity>

   <database-schema>
      The database has the following tables with their columns and types:
      ${state?.schema.tables
        .map(
          (t) =>
            `- Table: ${t.name}\n  Columns:\n${t.columns.map((c) => `    - ${c.name} (${c.type})`).join('\n')}`,
        )
        .join('\n\n')}

      Relationships (foreign keys):
      ${
        state?.schema.relationships?.length
          ? state.schema.relationships
              .map(
                (r) =>
                  `- ${r.table} (${r.from.join(', ')}) -> ${r.referenced_table} (${r.to.join(', ')})`,
              )
              .join('\n')
          : 'None detected'
      }
    </database-schema>

    <instructions>
      Write a business context that helps another agent answer questions accurately.

      For EACH table, do queries ONE AT A TIME:
      1. SELECT COUNT(*) to get row count
      2. SELECT * LIMIT 3 to see sample data

      Then write a report with:
      - What business this database is for
      - For each table: purpose, row count, and example of what the data looks like

      Include concrete examples like "Track prices are $0.99", "Customer names like 'Lu\u00eds Gon\u00e7alves'", etc.

      Keep it 400-600 words, conversational style.
    </instructions>
  `,
  tools: {
    query_database: tool({
      description:
        'Execute a SELECT query to explore the database and gather insights.',
      inputSchema: z.object({
        sql: z.string().describe('The SELECT query to execute'),
        purpose: z
          .string()
          .describe('What insight you are trying to gather with this query'),
      }),
      execute: ({ sql }) => {
        try {
          const result = db.prepare(sql).all();
          return result;
        } catch (error) {
          return {
            error:
              error instanceof Error ? error.message : 'Unknown error occurred',
          };
        }
      },
    }),
  },
});

async function runAndCache(
  inspection: ReturnType<typeof inspector>,
  cache: BriefCache,
) {
  const { text } = await generate(
    briefAgent,
    [
      user(
        'Please analyze the database and write a contextual report about what this database represents.',
      ),
    ],
    { schema: inspection },
  );

  await cache.set(text);
  return text;
}

export function runDBreifAgent(
  forceRefresh = false,
): StreamFunction<{
  dbPath: string;
  introspection: ReturnType<typeof inspector>;
}> {
  return (state) =>
    createUIMessageStream({
      execute: async ({ writer }) => {
        const cache = new BriefCache(state.dbPath);
        if (forceRefresh) {
          const brief = await runAndCache(state.introspection, cache);
          writer.write({
            type: 'data-brief-agent',
            data: {
              cache: 'forced',
              brief: brief,
            },
          });
        } else {
          let brief = await cache.get();
          if (!brief) {
            writer.write({
              type: 'data-brief-agent',
              data: {
                cache: 'miss',
              },
            });
            brief = await runAndCache(state.introspection, cache);
            writer.write({
              type: 'data-brief-agent',
              data: {
                cache: 'new',
                brief: brief,
              },
            });
          } else {
            writer.write({
              type: 'data-brief-agent',
              data: {
                cache: 'hit',
                brief: brief,
              },
            });
          }
        }
      },
    });
}
