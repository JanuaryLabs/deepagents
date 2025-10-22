/**
 * Demo runner for Plan-and-Solve Plus (PS+) implementation
 *
 * This file demonstrates the PS+ prompting technique from:
 * "Plan-and-Solve Prompting: Improving Zero-Shot Chain-of-Thought Reasoning by Large Language Models"
 * (arXiv:2305.04091)
 *
 * Run this file to see examples of:
 * 1. Single-path reasoning (deterministic, temperature=0)
 * 2. Self-consistency reasoning (multiple paths, temperature=0.7)
 * 3. Comparison between both approaches
 */
import {
  EXAMPLE_PROBLEMS,
  compareApproaches,
  demonstrateSelfConsistency,
  runAllExamples,
  runSelfConsistency,
  runSinglePath,
} from './examples.ts';

/**
 * Main demo function
 */
async function main() {
  const mode = process.argv[2] || 'quick';

  switch (mode) {
    case 'quick':
      await runSinglePath(EXAMPLE_PROBLEMS.arithmetic.simple);
      break;

    case 'self-consistency':
      // Demo self-consistency on a problem
      console.log('Mode: Self-Consistency Demo\n');
      await demonstrateSelfConsistency();
      break;

    case 'compare':
      // Compare single-path vs self-consistency
      console.log('Mode: Comparison Demo\n');
      await compareApproaches(EXAMPLE_PROBLEMS.arithmetic.complex, 10);
      break;

    case 'all':
      // Run all examples
      console.log('Mode: All Examples\n');
      await runAllExamples();
      break;

    case 'arithmetic':
      // Arithmetic reasoning examples
      console.log('Mode: Arithmetic Reasoning\n');
      console.log('\n--- Simple Problem ---');
      await runSinglePath(EXAMPLE_PROBLEMS.arithmetic.simple);
      console.log('\n--- Complex Problem ---');
      await runSinglePath(EXAMPLE_PROBLEMS.arithmetic.complex);
      console.log('\n--- Multi-step Problem ---');
      await runSinglePath(EXAMPLE_PROBLEMS.arithmetic.multistep);
      break;

    case 'symbolic':
      // Symbolic reasoning examples
      console.log('Mode: Symbolic Reasoning\n');
      console.log('\n--- Pattern Problem ---');
      await runSinglePath(EXAMPLE_PROBLEMS.symbolic.pattern);
      console.log('\n--- Sequence Problem ---');
      await runSinglePath(EXAMPLE_PROBLEMS.symbolic.sequence);
      console.log('\n--- Logic Problem ---');
      await runSinglePath(EXAMPLE_PROBLEMS.symbolic.logic);
      break;

    case 'commonsense':
      // Commonsense reasoning examples
      console.log('Mode: Commonsense Reasoning\n');
      console.log('\n--- Physical Reasoning ---');
      await runSinglePath(EXAMPLE_PROBLEMS.commonsense.physical);
      console.log('\n--- Temporal Reasoning ---');
      await runSinglePath(EXAMPLE_PROBLEMS.commonsense.temporal);
      console.log('\n--- Social Reasoning ---');
      await runSinglePath(EXAMPLE_PROBLEMS.commonsense.social);
      break;

    case 'help':
      printHelp();
      break;

    default:
      console.error(`Unknown mode: ${mode}`);
      printHelp();
      process.exit(1);
  }
}

/**
 * Print help information
 */
function printHelp() {
  console.log(`
Plan-and-Solve Plus (PS+) Demo Runner

Usage:
  npm run demo [mode] [options]

Modes:
  quick              Run a quick demo with a single arithmetic problem (default)
  self-consistency   Demonstrate self-consistency with multiple reasoning paths
  compare            Compare single-path vs self-consistency approaches
  all                Run all example problems
  arithmetic         Run all arithmetic reasoning examples
  symbolic           Run all symbolic reasoning examples
  commonsense        Run all commonsense reasoning examples
  custom <problem>   Run PS+ on a custom problem
  help               Show this help message

Examples:
  npm run demo
  npm run demo quick
  npm run demo self-consistency
  npm run demo compare
  npm run demo custom "If 5 apples cost $10, how much do 8 apples cost?"

About:
  This implementation is based on the paper:
  "Plan-and-Solve Prompting: Improving Zero-Shot Chain-of-Thought Reasoning by Large Language Models"
  Lei Wang et al., ACL 2023 (arXiv:2305.04091)

  Key features:
  - Two-phase approach: Planning → Execution
  - Enhanced with variable extraction and calculation instructions
  - Self-consistency via majority voting (optional)
  `);
}

// Run the demo
main().catch((error) => {
  console.error('Error running demo:', error);
  process.exit(1);
});
