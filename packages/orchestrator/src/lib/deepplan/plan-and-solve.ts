import { pl } from 'zod/v4/locales';

import {
  type Agent,
  type ContextVariables,
  execute,
  generate,
  user,
} from '@deepagents/agent';

import {
  type ExecutionContext,
  formatStepForExecutor,
} from './executors/generic-executor.ts';
import { type PlanStep, plan } from './planner-agent.ts';
import { replan } from './replanner-agent.ts';
import { synthesize } from './synthesizer.ts';

/**
 * Lifecycle hooks for Plan-and-Solve execution.
 *
 * These hooks allow you to intercept and react to key points in the execution lifecycle,
 * enabling progress tracking, persistence, notifications, and custom logic injection.
 *
 * **Important:** You can manually terminate the execution loop by setting `context.is_complete = true`
 * in either hook. This allows you to stop execution early based on custom conditions (e.g., user cancellation,
 * resource limits, or completion detection).
 */
export interface PlanHooks {
  /**
   * Hook executed immediately after the initial plan is created.
   *
   * **When to use:**
   * - Review and validate the initial plan
   * - Persist the initial plan to storage
   * - Log the planned steps for auditing
   * - Modify the plan before execution starts
   * - Display the plan to users for confirmation
   * - Estimate total execution time or cost
   * - **Terminate execution before it starts** by setting `context.is_complete = true`
   *
   * **Timing:** After the planner agent creates the initial plan, before any step execution
   *
   * @param context - Initial execution context with the complete plan
   * @returns Modified context (or undefined to keep current context)
   *
   * @example
   * ```typescript
   * onInitialPlan: async (context) => {
   *   // Log the initial plan
   *   console.log(`Plan created with ${context.current_plan.length} steps`);
   *
   *   // Save for later review
   *   await writeFile('initial_plan.json', JSON.stringify(context, null, 2));
   *
   *   // Validate plan isn't too complex
   *   if (context.current_plan.length > 20) {
   *     console.error('Plan too complex, aborting');
   *     context.is_complete = true;
   *   }
   *
   *   return context;
   * }
   * ```
   */
  onInitialPlan?: (
    context: ExecutionContext,
  ) => Promise<ExecutionContext | void> | ExecutionContext | void;

  /**
   * Hook executed before replanning occurs (after a step completes).
   *
   * **When to use:**
   * - Save execution progress/checkpoints
   * - Log intermediate results for auditing
   * - Modify context before the replanner evaluates it
   * - Track execution metrics
   * - Stream progress updates to a client/UI
   * - **Terminate execution early** by setting `context.is_complete = true`
   *
   * **Timing:** After a step executes, before the replanner agent runs
   *
   * @param context - Current execution state including completed step results
   * @returns Modified context (or undefined to keep current context)
   */
  beforeReplan?: (
    context: ExecutionContext,
  ) => Promise<ExecutionContext | void> | ExecutionContext | void;

  /**
   * Hook executed after replanning occurs and the plan is updated.
   *
   * **When to use:**
   * - Persist the updated plan to storage
   * - Log plan changes and reasoning
   * - Notify users of plan adjustments
   * - Update progress indicators
   * - Implement custom plan filtering/validation
   * - Stream plan updates to a dashboard
   * - Send alerts if major changes occur
   * - **Terminate execution early** by setting `context.is_complete = true`
   *
   * **Timing:** After the replanner agent has updated the plan, before next step execution
   *
   * @param context - Current execution state with updated plan
   * @returns Modified context (or undefined to keep current context)
   */
  afterReplan?: (
    context: ExecutionContext,
  ) => Promise<ExecutionContext | void> | ExecutionContext | void;
}

async function runExecutor(
  agent: Agent<any, any>,
  context: ExecutionContext,
  step: PlanStep,
  state: ContextVariables,
) {
  const { text } = await generate(
    agent,
    [user(formatStepForExecutor(step, context))],
    state,
  );
  return {
    ...context,
    variables: { ...context.variables },
    step_results: [...context.step_results, text],
  };
}

/**
 * Executes a Plan-and-Solve Plus (PS+) workflow with adaptive replanning.
 *
 * This function creates a complete autonomous task execution pipeline:
 * 1. Plans the task into specific steps
 * 2. Executes each step sequentially
 * 3. Replans after each execution to adapt based on results
 * 4. Synthesizes results into a final output
 *
 * @param options - Configuration for the plan-and-solve execution
 * @param options.input - The user's request or task description
 * @param options.executor - The agent that will execute individual plan steps
 * @param options.state - Execution context variables (e.g., repo_path, API keys)
 * @param options.hooks - Optional lifecycle hooks for extensibility (see {@link PlanHooks})
 *
 * @example
 * ```typescript
 * const result = await planAndSolve({
 *   input: "Find all AI startups that raised Series A",
 *   executor: researchExecutor,
 *   state: {
 *      repo_path: process.cwd()
 *   },
 *      environment: {
 *     executor_type: 'research',
 *     available_tools: ['browser_search', 'scratchpad'],
 *     domain: 'market research',
 *     capabilities: ['web search', 'source verification', 'numerical data extraction']
 *   },
 *   },
 *   hooks: {
 *     beforeReplan: async (context) => {
 *       // Save progress before replanning
 *       await saveCheckpoint(context);
 *       return context;
 *     },
 *     afterReplan: async (context) => {
 *       // Log plan updates
 *       console.log(`Updated plan: ${context.current_plan.length} steps remaining`);
 *       return context;
 *     }
 *   }
 * });
 * ```
 */
export async function planAndSolve(options: {
  input: string;
  executor: Agent<any, any>;
  state: ContextVariables;
  hooks?: PlanHooks;
}) {
  let context = await plan(options.input);
  const plans = [context.current_plan];

  if (options.hooks?.onInitialPlan) {
    const initialPlanResult = await options.hooks.onInitialPlan(context);
    if (initialPlanResult) {
      context = initialPlanResult;
    }
  }

  if (context.is_complete) {
    return synthesize(context.step_results, context.original_request);
  }

  while (context.current_plan.length > 0) {
    const currentStep = context.current_plan[0];
    context = await runExecutor(
      options.executor,
      context,
      currentStep,
      options.state,
    );
    if (options.hooks?.beforeReplan) {
      const beforeReplanResult = await options.hooks.beforeReplan(context);
      if (beforeReplanResult) {
        context = beforeReplanResult;
      }
    }
    if (context.is_complete) {
      // User requested early termination
      break;
    }

    // -- Start Replanning --
    context = await replan(context);
    plans.push(context.current_plan);
    // -- End Replanning --

    if (options.hooks?.afterReplan) {
      const afterReplanResult = await options.hooks.afterReplan(context);
      if (afterReplanResult) {
        context = afterReplanResult;
      }
    }

    if (context.is_complete) {
      break;
    }
  }

  options.state.plans = plans;
  return synthesize(context.step_results, context.original_request);
}
