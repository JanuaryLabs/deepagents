/**
 * Plan-and-Solve Plus (PS+) Implementation
 *
 * Implements the enhanced PS+ prompting technique from the paper:
 * "Plan-and-Solve Prompting: Improving Zero-Shot Chain-of-Thought Reasoning by Large Language Models"
 * (arXiv:2305.04091)
 *
 * @module plan-and-solve
 */

// Agent exports
export {
  planAndSolveAgent,
  createPlanAndSolveAgent,
} from './plan-and-solve-agent.ts';

// Self-consistency exports
export {
  planAndSolveWithSelfConsistency,
  analyzeReasoningDiversity,
} from './self-consistency.ts';

// Type exports
export type {
  ReasoningStep,
  PlanAndSolveOutput,
  SelfConsistencyResult,
  PlanAndSolveConfig,
} from './types.ts';

// Example exports
export {
  EXAMPLE_PROBLEMS,
  runSinglePath,
  runSelfConsistency,
  compareApproaches,
  runAllExamples,
  demonstrateSelfConsistency,
} from './examples.ts';
