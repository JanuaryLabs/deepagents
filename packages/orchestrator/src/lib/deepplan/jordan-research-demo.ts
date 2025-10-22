import { writeFile } from 'node:fs/promises';

import { planAndSolve } from './plan-and-solve.ts';
import { researchExecutor } from './research-executor.ts';

/**
 * Jordan Car Market Research Demo
 *
 * Demonstrates the adaptive planning system for socioeconomic research.
 *
 * Research Question:
 * "Why do Jordanians still purchase economical cars made before 2000?"
 *
 * This will:
 * 1. Create an initial research plan
 * 2. Execute research steps using web search
 * 3. Adaptively adjust the plan based on findings
 * 4. Synthesize a comprehensive research report
 *
 * Expected topics to discover:
 * - Tax structure (customs, import duties)
 * - Economic factors (income levels, affordability)
 * - Regulatory environment
 * - Market dynamics (supply, financing)
 * - Cultural factors
 */

console.log('🚗 Starting Jordan Car Market Research...\n');
console.log(
  'Research Question: Why do Jordanians still purchase economical cars made before 2000?\n',
);

const result = await planAndSolve({
  input: `
    Research Question: Why do Jordanians still purchase economical cars made before 2000?

    Requirements:
    - Focus on economical/budget car segment
    - Analyze both economic and non-economic factors
    - Include numerical data (taxes, prices, incomes, percentages)
    - Identify primary vs secondary factors
    - Provide concrete examples with calculations
    - Compare against newer vehicle options
    - Consider regulatory, cultural, and market dynamics

    The analysis should be comprehensive and data-driven, with all claims backed by sources.
  `,

  executor: researchExecutor,

  state: {
    country: 'Jordan',
    research_type: 'socioeconomic',
    vehicle_segment: 'economical',
    analysis_scope: 'comprehensive',
  },

  hooks: {
    onInitialPlan: async (context) => {
      console.log('📋 Initial Research Plan Created:\n');
      console.log(`Understanding: ${context.understanding}\n`);
      console.log(`Steps planned: ${context.current_plan.length}\n`);
      context.current_plan.forEach((step, i) => {
        console.log(`  ${i + 1}. ${step.description}`);
        console.log(`     Expected: ${step.expected_outcome}\n`);
      });
      console.log('---\n');
    },

    beforeReplan: async (context) => {
      const stepNum = context.step_results.length;
      console.log(`\n✅ Step ${stepNum} Completed\n`);
      console.log('Latest findings (truncated):');
      const latestResult =
        context.step_results[context.step_results.length - 1];
      console.log(latestResult.substring(0, 300) + '...\n');
      console.log('---\n');
    },

    afterReplan: async (context) => {
      console.log('🔄 Plan Adjusted\n');
      console.log(`Remaining steps: ${context.current_plan.length}\n`);
      if (context.current_plan.length > 0) {
        console.log('Next steps:');
        context.current_plan.slice(0, 3).forEach((step, i) => {
          console.log(`  ${i + 1}. ${step.description}`);
        });
        if (context.current_plan.length > 3) {
          console.log(`  ... and ${context.current_plan.length - 3} more`);
        }
      } else {
        console.log('✨ Research complete! Moving to synthesis...');
      }
      console.log('\n---\n');

      // Save progress checkpoint
      await writeFile(
        `jordan_research_checkpoint_${Date.now()}.json`,
        JSON.stringify(context, null, 2),
      );
    },
  },
});

// Save the final report
const filename = 'jordan_car_market_report.md';
await writeFile(filename, result);

console.log('\n✅ Research Complete!\n');
console.log(`📄 Report saved to: ${filename}\n`);
console.log('Preview:');
console.log(result.substring(0, 500) + '...\n');
