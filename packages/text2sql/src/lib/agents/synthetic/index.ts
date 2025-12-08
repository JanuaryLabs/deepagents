import { generate, user } from '@deepagents/agent';

import type { Adapter } from '../../adapters/adapter.ts';
import {
  type QuestionComplexity,
  questionGeneratorAgent,
} from './question.agent.ts';

export * from './question.agent.ts';
export * from './sql.agent.ts';

/**
 * Predefined perspectives for generating diverse questions.
 */
export const perspectives = {
  sales_manager: `a Sales Manager focused on revenue targets, deal pipeline, customer relationships, and team performance metrics`,
  data_analyst: `a Data Analyst interested in patterns, correlations, data quality issues, and statistical insights`,
  marketing_lead: `a Marketing Lead tracking campaign performance, customer acquisition, conversion rates, and ROI`,
  executive: `an Executive wanting high-level KPIs, trends, year-over-year comparisons, and strategic insights`,
  customer_support: `a Customer Support Manager monitoring ticket volumes, resolution times, satisfaction scores, and agent performance`,
  operations: `an Operations Manager focused on efficiency, throughput, bottlenecks, and resource utilization`,
  finance: `a Finance Analyst concerned with revenue recognition, cost analysis, budget variance, and financial compliance`,
  product_manager: `a Product Manager tracking feature adoption, user engagement, retention metrics, and product performance`,
} as const;

interface SyntheticDataGeneratorConfig {
  perspectives?: string[];
  complexities?: QuestionComplexity[];
  countPerCombination?: number;
}

class SyntheticDataGenerator {
  #adapter: Adapter;
  #config: Required<SyntheticDataGeneratorConfig>;

  constructor(adapter: Adapter, config: SyntheticDataGeneratorConfig = {}) {
    this.#adapter = adapter;
    this.#config = {
      perspectives: config.perspectives ?? Object.values(perspectives),
      complexities: config.complexities ?? ['low', 'medium', 'hard', 'window'],
      countPerCombination: config.countPerCombination ?? 1,
    };
  }

  /**
   * Generate a diverse set of questions by iterating through all
   * complexity × perspective combinations.
   */
  async generateDiverseQuestions(): Promise<
    Array<{
      question: string;
      complexity: QuestionComplexity;
      perspective: string;
    }>
  > {
    const introspection = await this.#adapter.introspect();
    const results: Array<{
      question: string;
      complexity: QuestionComplexity;
      perspective: string;
    }> = [];

    for (const complexity of this.#config.complexities) {
      for (const perspective of this.#config.perspectives) {
        const { experimental_output: output } = await generate(
          questionGeneratorAgent,
          [user(`As ${perspective}, generate questions I would ask about this data.`)],
          {
            complexity,
            count: this.#config.countPerCombination,
            introspection,
          },
        );

        for (const question of output.questions) {
          results.push({ question, complexity, perspective });
        }
      }
    }

    return results;
  }

}

export function synthetic(config: SyntheticDataGeneratorConfig = {}) {
  return (adapter: Adapter) => new SyntheticDataGenerator(adapter, config);
}
