import { groq } from '@ai-sdk/groq';
import { tool } from 'ai';
import dedent from 'dedent';
import z from 'zod';

import { type AgentModel } from '@deepagents/agent';
import {
  ContextEngine,
  InMemoryContextStore,
  agent,
  fragment,
  persona,
  user,
} from '@deepagents/context';

import type { Adapter } from '../adapter.ts';
import { AbstractGrounding } from './abstract.grounding.ts';
import type { GroundingContext } from './context.ts';

/**
 * Cache interface for storing generated reports.
 */
export interface ReportCache {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}

/**
 * Configuration for ReportGrounding.
 */
export interface ReportGroundingConfig {
  /** LLM model to use for generating the report */
  model?: AgentModel;
  /** Optional cache for storing generated reports */
  cache?: ReportCache;
  /** Force regeneration even if cached */
  forceRefresh?: boolean;
}

/**
 * Grounding that generates a business context report about the database.
 *
 * Uses an LLM agent to:
 * 1. Query COUNT(*) for each table
 * 2. Query SELECT * LIMIT 3 for sample data
 * 3. Generate a 400-600 word business context report
 *
 * The report helps downstream agents understand what the database represents.
 */
export class ReportGrounding extends AbstractGrounding {
  #adapter: Adapter;
  #model: AgentModel;
  #cache?: ReportCache;
  #forceRefresh: boolean;

  constructor(adapter: Adapter, config: ReportGroundingConfig = {}) {
    super('business_context');
    this.#adapter = adapter;
    this.#model = config.model ?? groq('openai/gpt-oss-20b');
    this.#cache = config.cache;
    this.#forceRefresh = config.forceRefresh ?? false;
  }

  async execute(ctx: GroundingContext): Promise<void> {
    // Check cache first (unless forcing refresh)
    if (!this.#forceRefresh && this.#cache) {
      const cached = await this.#cache.get();
      if (cached) {
        ctx.report = cached;
        return;
      }
    }

    // Generate report using LLM
    const report = await this.#generateReport();
    ctx.report = report;

    // Cache the result
    if (this.#cache) {
      await this.#cache.set(report);
    }
  }

  async #generateReport(): Promise<string> {
    const context = new ContextEngine({
      store: new InMemoryContextStore(),
      chatId: `report-gen-${crypto.randomUUID()}`,
      userId: 'system',
    });

    context.set(
      persona({
        name: 'db-report-agent',
        role: 'Database analyst',
        objective:
          'Analyze the database and write a contextual report about what it represents',
      }),
      fragment(
        'instructions',
        dedent`
          Write a business context that helps another agent answer questions accurately.

          For EACH table, do queries ONE AT A TIME:
          1. SELECT COUNT(*) to get row count
          2. SELECT * LIMIT 3 to see sample data

          Then write a report with:
          - What business this database is for
          - For each table: purpose, row count, and example of what the data looks like

          Include concrete examples like "Track prices are $0.99",
          "Customer names like 'Luís Gonçalves'", etc.

          Keep it 400-600 words, conversational style.
        `,
      ),
      user(
        'Please analyze the database and write a contextual report about what this database represents.',
      ),
    );

    const adapter = this.#adapter;

    const reportAgent = agent({
      name: 'db-report-agent',
      model: this.#model,
      context,
      tools: {
        query_database: tool({
          description:
            'Execute a SELECT query to explore the database and gather insights.',
          inputSchema: z.object({
            sql: z.string().describe('The SELECT query to execute'),
            purpose: z
              .string()
              .describe(
                'What insight you are trying to gather with this query',
              ),
          }),
          execute: ({ sql }) => {
            return adapter.execute(sql);
          },
        }),
      },
    });

    const result = await reportAgent.generate({});
    return result.text;
  }
}
