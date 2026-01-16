import { groq } from '@ai-sdk/groq';
import dedent from 'dedent';
import z from 'zod';

import {
  ContextEngine,
  InMemoryContextStore,
  fragment,
  persona,
  structuredOutput,
  user,
} from '@deepagents/context';

import type { Adapter } from '../../adapters/adapter.ts';
import { type ExtractedPair, PairProducer } from '../types.ts';

export interface SqlExtractorOptions {
  validateSql?: boolean;
  skipInvalid?: boolean;
}

const outputSchema = z.object({
  question: z
    .string()
    .describe('A natural language question that the SQL query answers'),
});
/**
 * SqlExtractor - Generate questions for existing SQL queries.
 *
 * Given a list of SQL queries, uses an LLM to generate the natural
 * language questions they answer.
 */
export class SqlExtractor extends PairProducer {
  #sqls: string[];
  #adapter: Adapter;
  #options: SqlExtractorOptions;

  /**
   * @param sql - SQL query or queries to generate questions for
   * @param adapter - Database adapter for validation and schema introspection
   * @param options - Extraction configuration
   */
  constructor(
    sql: string[] | string,
    adapter: Adapter,
    options: SqlExtractorOptions = {},
  ) {
    super();
    this.#sqls = Array.isArray(sql) ? sql : [sql];
    this.#adapter = adapter;
    this.#options = options;
  }

  /**
   * Generates natural language questions for each SQL query using an LLM.
   * @returns Pairs with generated questions and original SQL
   */
  async *produce(): AsyncGenerator<ExtractedPair[]> {
    const { validateSql = true, skipInvalid = false } = this.#options;
    // TODO: Update to use fragments and render them
    // const schemaFragments = await this.#adapter.introspect();
    // const introspection = new XmlRenderer().render(schemaFragments);
    const introspection = '' as any; // Placeholder - synthesis needs to be updated to use fragments

    for (const sql of this.#sqls) {
      let isValid = true;
      if (validateSql) {
        const error = await this.#adapter.validate(sql);
        isValid = error === undefined || error === null;

        if (!isValid && skipInvalid) {
          continue;
        }
      }

      const context = new ContextEngine({
        store: new InMemoryContextStore(),
        chatId: `sql-to-question-${crypto.randomUUID()}`,
        userId: 'system',
      });

      context.set(
        persona({
          name: 'sql_to_question',
          role: 'You are an expert at understanding SQL queries and generating clear, natural language questions that describe what the query retrieves.',
          objective:
            'Generate clear, natural language questions that describe what SQL queries retrieve',
        }),
        fragment('database_schema', introspection),
        fragment('sql', sql),
        fragment(
          'task',
          dedent`
            Given the database schema and the SQL query above, generate a single
            natural language question that:
            1. Accurately describes what information the query retrieves
            2. Uses natural business language (not SQL terminology)
            3. Could be asked by a non-technical user
            4. Is concise but complete
          `,
        ),
        fragment(
          'examples',
          dedent`
            SQL: SELECT COUNT(*) FROM customers WHERE region = 'NY'
            Question: "How many customers do we have in New York?"

            SQL: SELECT product_name, SUM(quantity) as total FROM orders GROUP BY product_name ORDER BY total DESC LIMIT 10
            Question: "What are our top 10 products by quantity sold?"

            SQL: SELECT c.name, COUNT(o.id) FROM customers c LEFT JOIN orders o ON c.id = o.customer_id GROUP BY c.id HAVING COUNT(o.id) = 0
            Question: "Which customers have never placed an order?"
          `,
        ),
        user('Generate a natural language question for this SQL query.'),
      );

      const sqlToQuestionOutput = structuredOutput({
        model: groq('openai/gpt-oss-20b'),
        context,
        schema: outputSchema,
      });

      const output = await sqlToQuestionOutput.generate();

      yield [
        {
          question: output.question,
          sql,
          success: isValid,
        },
      ];
    }
  }
}
