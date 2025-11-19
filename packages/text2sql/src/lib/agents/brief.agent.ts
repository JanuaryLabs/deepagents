import { groq } from '@ai-sdk/groq';
import { createUIMessageStream, tool } from 'ai';
import dedent from 'dedent';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import z from 'zod';

import {
  type StreamFunction,
  agent,
  generate,
  toState,
  user,
} from '@deepagents/agent';

import { Adapter, type Introspection } from '../adapters/adapter.ts';
import { databaseSchemaPrompt } from '../prompt.ts';

export class BriefCache {
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
    introspection: Introspection;
  }
>({
  name: 'db-brief-agent',
  model: groq('openai/gpt-oss-20b'),
  prompt: (state) => dedent`
    <identity>
      You are a database analyst expert. Your job is to understand what a database represents and provide business context about it.
      You have READ-ONLY access to the database.
    </identity>

    ${databaseSchemaPrompt(state!)}

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
      execute: ({ sql }, options) => {
        const state = toState<Adapter>(options);
        return state.execute(sql);
      },
    }),
  },
});

async function runAndCache(introspection: Introspection, cache: BriefCache) {
  const { text } = await generate(
    briefAgent,
    [
      user(
        'Please analyze the database and write a contextual report about what this database represents.',
      ),
    ],
    { introspection },
  );

  await cache.set(text);
  return text;
}

export async function generateBrief(
  introspection: Introspection,
  cache: BriefCache,
) {
  const brief = await cache.get();
  if (!brief) {
    return runAndCache(introspection, cache);
  }
  return brief;
}

export function toBrief(forceRefresh = false): StreamFunction<
  {
    cache: BriefCache;
    introspection: Introspection;
  },
  { context: string }
> {
  return (state, setState) => {
    return createUIMessageStream({
      execute: async ({ writer }) => {
        if (forceRefresh) {
          const brief = await runAndCache(state.introspection, state.cache);
          writer.write({
            type: 'data-brief-agent',
            data: {
              cache: 'forced',
              brief: brief,
            },
          });
          setState({ context: brief });
        } else {
          let brief = await state.cache.get();
          if (!brief) {
            writer.write({
              type: 'data-brief-agent',
              data: {
                cache: 'miss',
              },
            });
            brief = await runAndCache(state.introspection, state.cache);
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
  };
}
