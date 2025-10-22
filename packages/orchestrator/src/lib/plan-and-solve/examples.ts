import { execute, printer, toOutput, user } from '@deepagents/agent';

import { planAndSolveAgent } from './plan-and-solve-agent.ts';
import {
  analyzeReasoningDiversity,
  planAndSolveWithSelfConsistency,
} from './self-consistency.ts';
import type { PlanAndSolveOutput } from './types.ts';

/**
 * Example problems from different reasoning categories
 * Based on the paper's evaluation datasets
 */
export const EXAMPLE_PROBLEMS = {
  // Arithmetic Reasoning (GSM8K-style)
  arithmetic: {
    simple: `A baker made 23 cupcakes. He sold 18 of them in the morning and made 15 more in the afternoon. How many cupcakes does he have now?`,
    complex: `A store has 4 shelves. Each shelf has 6 boxes. Each box contains 8 items. If the store sells 3 full boxes, how many items are left in the store?`,
    multistep: `Sarah has $450. She buys 3 books for $15 each and 2 notebooks for $8 each. Then she finds $20 on the ground. She spends half of her remaining money on a jacket. How much money does Sarah have left?`,
  },

  // Symbolic Reasoning
  symbolic: {
    pattern: `If A is to B as C is to D, and B is to C as D is to E, what is the relationship between A and E?`,
    sequence: `What comes next in the sequence: 2, 6, 12, 20, 30, ?`,
    logic: `All roses are flowers. Some flowers are red. Does this mean that some roses are red?`,
  },

  // Commonsense Reasoning
  commonsense: {
    physical: `If you place a metal spoon in a cup of hot coffee, what will happen to the temperature of the spoon after a few minutes?`,
    temporal: `If it takes 5 machines 5 minutes to make 5 widgets, how long would it take 100 machines to make 100 widgets?`,
    social: `Tom has 3 apples and gives one to his friend. His friend already had 2 apples. How many apples does Tom's friend have now?`,
  },
};

/**
 * Run a single problem with PS+ (deterministic, temperature=0)
 */
export async function runSinglePath(problem: string) {
  console.log('\nProblem:', problem);
  console.log('\n' + '-'.repeat(80) + '\n');

  const result = execute(planAndSolveAgent, [user(problem)], {});

  // Stream the output to see the reasoning process
  await printer.stdout(result);

  const output = await toOutput(result);
  console.dir(output, { depth: null });
  return output;
}

/**
 * Run a problem with self-consistency (multiple paths, temperature=0.7)
 */
export async function runSelfConsistency(problem: string, numPaths = 10) {
  console.log('\n' + '='.repeat(80));
  console.log(`SELF-CONSISTENCY MODE (${numPaths} paths, Temperature = 0.7)`);
  console.log('='.repeat(80));
  console.log('\nProblem:', problem);
  console.log('\n' + '-'.repeat(80) + '\n');

  const result = await planAndSolveWithSelfConsistency(problem, numPaths);

  // Analyze reasoning diversity
  const diversity = analyzeReasoningDiversity(result);
  console.log('Diversity Analysis:');
  console.log(`  Unique answers: ${diversity.uniqueAnswers}`);
  console.log(`  Entropy: ${diversity.entropy.toFixed(3)}`);
  console.log(
    `  Diversity score: ${(diversity.diversityScore * 100).toFixed(1)}%`,
  );
  console.log('='.repeat(80) + '\n');

  return result;
}

/**
 * Compare single-path vs self-consistency for a given problem
 */
export async function compareApproaches(problem: string, numPaths = 5) {
  // Run single path
  const singlePathResult = await runSinglePath(problem);

  console.log('\n' + '─'.repeat(80) + '\n');

  // Run self-consistency
  const scResult = await runSelfConsistency(problem, numPaths);

  // Compare results
  console.log('\n' + '█'.repeat(80));
  console.log('COMPARISON SUMMARY');
  console.log('█'.repeat(80));
  console.log('\nSingle Path Answer:', singlePathResult.final_answer);
  console.log('Self-Consistency Answer:', scResult.majority_answer);
  console.log(
    'Confidence:',
    `${(scResult.confidence_score * 100).toFixed(1)}%`,
  );

  const answersMatch =
    String(singlePathResult.final_answer).trim().toLowerCase() ===
    String(scResult.majority_answer).trim().toLowerCase();
  console.log('Answers Match:', answersMatch ? 'YES ✓' : 'NO ✗');

  return {
    singlePath: singlePathResult,
    selfConsistency: scResult,
    answersMatch,
  };
}

/**
 * Run all example problems (useful for testing)
 */
export async function runAllExamples() {
  console.log('\n🚀 Running Plan-and-Solve Plus Examples\n');

  // Arithmetic examples
  console.log('\n📊 ARITHMETIC REASONING\n');
  await runSinglePath(EXAMPLE_PROBLEMS.arithmetic.simple);
  await runSinglePath(EXAMPLE_PROBLEMS.arithmetic.multistep);

  // Symbolic reasoning examples
  console.log('\n🔣 SYMBOLIC REASONING\n');
  await runSinglePath(EXAMPLE_PROBLEMS.symbolic.sequence);

  // Commonsense reasoning examples
  console.log('\n🧠 COMMONSENSE REASONING\n');
  await runSinglePath(EXAMPLE_PROBLEMS.commonsense.temporal);

  console.log('\n✅ All examples completed!\n');
}

/**
 * Demonstrate self-consistency on a challenging problem
 */
export async function demonstrateSelfConsistency() {
  console.log('\n🔬 Demonstrating Self-Consistency\n');

  // Use a more challenging problem where different paths might help
  const challengingProblem = EXAMPLE_PROBLEMS.arithmetic.multistep;

  await compareApproaches(challengingProblem, 10);
}
