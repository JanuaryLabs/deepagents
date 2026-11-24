import type { PlanStep, PlannerOutput } from '../planner-agent.ts';

/**
 * Format step for executor with full context
 */
export function formatStepForExecutor(
  step: PlanStep,
  context: ExecutionContext,
): string {
  return `
<UserRequest>${context.original_request}</UserRequest>

<Understanding>${context.understanding}</Understanding>

<CurrentVariables>
${JSON.stringify(context.variables, null, 2)}
</CurrentVariables>

<PreviousSteps>
${context.step_results.length ? context.step_results.map((result, i) => `Step ${i + 1}: ${result}`).join('\n') : 'No previous steps'}
</PreviousSteps>

<CurrentStep>
Step Description: ${step.description}
Expected Outcome: ${step.expected_outcome}
</CurrentStep>

Execute this step and provide a detailed report of what you find.
  `.trim();
}

export function createExecutionContext(
  request: string,
  plannerOutput: PlannerOutput,
): ExecutionContext {
  return {
    original_request: request,
    understanding: plannerOutput.understanding,
    initial_plan: plannerOutput.steps,
    current_plan: [...plannerOutput.steps],
    variables: { ...plannerOutput.variables },
    step_results: [],
    is_complete: false,
  };
}

export interface ExecutionContext {
  // Request information
  original_request: string;
  understanding: string;

  // Planning state
  initial_plan: PlanStep[];
  current_plan: PlanStep[];

  // Data collected
  variables: Record<string, string | number | boolean>;

  // Execution history
  step_results: string[];

  // Status
  is_complete: boolean;
  success_criteria_met?: boolean;
}
