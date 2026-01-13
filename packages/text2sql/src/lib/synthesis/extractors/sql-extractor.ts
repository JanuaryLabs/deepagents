import { groq } from '@ai-sdk/groq';
import dedent from 'dedent';
import z from 'zod';

import { agent, generate, user } from '@deepagents/agent';

import type { Adapter } from '../../adapters/adapter.ts';
import { type ExtractedPair, PairProducer } from '../types.ts';

export interface SqlExtractorOptions {
  validateSql?: boolean;
  skipInvalid?: boolean;
}

/**
 * Agent that generates natural language questions from SQL queries.
 */
const sqlToQuestionAgent = agent<
  { question: string },
  { sql: string; introspection: string }
>({
  name: 'sql_to_question',
  model: groq('llama-3.3-70b-versatile'),
  output: z.object({
    question: z
      .string()
      .describe('A natural language question that the SQL query answers'),
  }),
  prompt: (state) => dedent`
    <identity>
      You are an expert at understanding SQL queries and generating clear,
      natural language questions that describe what the query retrieves.
    </identity>

    <schema>
    ${state?.introspection}
    </schema>

    <sql>
    ${state?.sql}
    </sql>

    <task>
      Given the database schema and the SQL query above, generate a single
      natural language question that:
      1. Accurately describes what information the query retrieves
      2. Uses natural business language (not SQL terminology)
      3. Could be asked by a non-technical user
      4. Is concise but complete
    </task>

    <examples>
      SQL: SELECT COUNT(*) FROM customers WHERE region = 'NY'
      Question: "How many customers do we have in New York?"

      SQL: SELECT product_name, SUM(quantity) as total FROM orders GROUP BY product_name ORDER BY total DESC LIMIT 10
      Question: "What are our top 10 products by quantity sold?"

      SQL: SELECT c.name, COUNT(o.id) FROM customers c LEFT JOIN orders o ON c.id = o.customer_id GROUP BY c.id HAVING COUNT(o.id) = 0
      Question: "Which customers have never placed an order?"
    </examples>
  `,
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

      const { experimental_output } = await generate(
        sqlToQuestionAgent,
        [user('Generate a natural language question for this SQL query.')],
        {
          sql,
          introspection,
        },
      );

      yield [
        {
          question: experimental_output.question,
          sql,
          success: isValid,
        },
      ];
    }
  }
}
