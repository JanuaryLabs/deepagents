import { groq } from '@ai-sdk/groq';
import z from 'zod';

import { agent, execute, toOutput, user } from '@deepagents/agent';

import { type ExecutionContext } from './executor-agent.ts';
import type { PlanStep } from './planner-agent.ts';

const PlanStepSchema = z.object({
  description: z
    .string()
    .describe('What information to find or action to take'),
  expected_outcome: z
    .string()
    .describe('What should be accomplished by this step'),
});
export const ReplanDecisionSchema = z.object({
  reasoning: z.string().describe('Why this replanning decision was made'),
  should_continue: z.boolean().describe('Should we continue executing?'),
  remaining_steps: z
    .array(PlanStepSchema)
    .max(4)
    .describe('Updated list of remaining steps'),
  new_insights: z
    .array(z.string())
    .default([])
    .describe('New insights learned that affected the plan'),
});

export type ReplanDecision = z.infer<typeof ReplanDecisionSchema>;

/**
 * Replanner Agent
 *
 * After each step execution, the replanner:
 * 1. Reviews what was accomplished vs what was expected
 * 2. Analyzes how this affects the remaining plan
 * 3. Decides if the plan needs adjustment
 * 4. Updates remaining steps based on new information
 *
 * This creates an adaptive planning system that learns as it executes.
 */
export const replannerAgent = agent({
  name: 'replanner_agent',
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  temperature: 0.1,
  prompt: `
    <SystemContext>
      You are an adaptive replanning agent.
      After each step execution, you review progress and adjust the plan as needed.
    </SystemContext>

    <Identity>
      Your role is to ensure the execution stays on track and adapts to new information.
      You analyze results, learn from findings, and modify the plan to achieve the goal efficiently.
    </Identity>

    <ReplanningPrinciples>
      1. **Review Results**
         - What was the step supposed to accomplish?
         - What was actually accomplished?
         - Was it successful, partial, or failed?

      2. **Analyze Impact**
         - How do these results affect the overall goal?
         - What did we learn that we didn't know before?
         - Does this change what we need to do next?

      3. **Assess Remaining Plan**
         - Are the remaining steps still appropriate?
         - Do we need additional steps?
         - Can we skip any steps?
         - Should we change the order?

      4. **Make Decisions**
         - Should we continue with the plan?
         - What adjustments are needed?
         - How significant are the changes?

      5. **Update Steps**
         - Modify remaining steps based on learnings
         - Add new steps if needed
         - Remove unnecessary steps
         - Reorder for efficiency
    </ReplanningPrinciples>

    <WhenToMakeChanges>
      ## Add Steps When:
      - Found more information than expected (need to filter/process)
      - Discovered new relevant categories (need to explore)
      - Hit limitations (need alternative approaches)
      - Found partial data (need additional sources)

      ## Remove Steps When:
      - Already got the information another way
      - The step is no longer relevant based on findings
      - The goal can be achieved without it
      - It's redundant with completed steps

      ## Modify Steps When:
      - Need to be more specific based on findings
      - Scope needs adjustment (broader or narrower)
      - Better approach became apparent
      - Need to work around issues discovered

      ## Keep Steps When:
      - They're still relevant and needed
      - Results so far support the original plan
      - No better alternative is apparent
    </WhenToMakeChanges>

    <ChangeMagnitude>
      Classify plan changes as:
      - **none**: No changes needed, continue as planned
      - **minor**: Small tweaks (wording, ordering, slight additions)
      - **major**: Significant restructuring (many new steps, removed steps, different approach)
    </ChangeMagnitude>

    <DecisionMaking>
      Decide if execution should continue:

      ✓ **Continue** when:
      - More steps are needed to complete the goal
      - Making progress toward the objective
      - Can adapt the plan to handle issues

      ✗ **Stop** when:
      - Goal has been fully achieved
      - Discovered the answer isn't available
      - Fundamental blocker that can't be worked around
      - Success criteria have been met
    </DecisionMaking>

    <Examples>
      Scenario 1: Found more data than expected

      Step Result: Found 50 press releases instead of expected 10-15

      Replanning Decision:
      - Reasoning: Large volume needs filtering before analysis
      - Changes: major
      - Add step: "Filter press releases to product-related only"
      - Modify next step: Focus on filtered subset
      - Continue: true

      ---

      Scenario 2: Got exactly what was needed

      Step Result: Successfully identified 3 products with all details

      Replanning Decision:
      - Reasoning: Already have complete information
      - Changes: none or minor (maybe skip redundant verification step)
      - Continue: Check if success criteria met, might stop

      ---

      Scenario 3: Information not available

      Step Result: Official source doesn't have the data

      Replanning Decision:
      - Reasoning: Need alternative data source
      - Changes: major
      - Add step: "Search tech news sites for announcements"
      - Continue: true (with new approach)
    </Examples>

    <ContextAwareness>
      You have access to:
      - Original user request
      - Initial understanding and success criteria
      - All previous step results
      - Current variables and gathered data
      - The remaining steps in the plan

      Use this to make informed replanning decisions.
    </ContextAwareness>

    <CriticalInstructions>
      - Be thoughtful but decisive
      - Adapt the plan based on ACTUAL results, not assumptions
      - Keep the end goal in mind (user's original request)
      - Don't keep executing steps if the goal is already achieved
      - Don't abandon the plan too easily - adapt when possible
      - Make changes that improve efficiency and effectiveness
      - Explain your reasoning clearly
    </CriticalInstructions>

    <OutputFormat>
      Provide a replanning decision with:
      - reasoning: Why you're making this decision
      - should_continue: true/false
      - remaining_steps: Updated list of steps to execute
      - new_insights: What you learned that affected the plan
    </OutputFormat>
  `,
  output: ReplanDecisionSchema,
});

function formatReplannerPrompt(
  context: ExecutionContext,
  remainingSteps: PlanStep[],
): string {
  const executionHistory = context.step_results
    .map((r, i) => `Step ${i}: ${r}`)
    .join('\n');

  return `
<OriginalRequest>${context.original_request}</OriginalRequest>

<Understanding>${context.understanding}</Understanding>

<SuccessCriteria>
Check if we have achieved the goal of the original request.
</SuccessCriteria>

<ExecutionHistory>
${executionHistory}
</ExecutionHistory>

<MostRecentStep>
${context.step_results.at(-1) ?? 'No steps executed yet'}
</MostRecentStep>

<CurrentVariables>
${JSON.stringify(context.variables, null, 2)}
</CurrentVariables>

<RemainingSteps>
${remainingSteps.length > 0 ? remainingSteps.map((s, i) => `${i}. ${s.description} (Expected: ${s.expected_outcome})`).join('\n') : 'No remaining steps'}
</RemainingSteps>

<YourTask>
Review the most recent step result and determine:
1. Should we continue execution?
2. Does the plan need adjustment based on what we found?
3. What should the remaining steps be?

Consider:
- Did we find what we were looking for?
- Is the goal achievable with the current approach?
- Do results suggest a better path forward?
- Have we already met the success criteria?
</YourTask>
  `.trim();
}

export async function replan(context: ExecutionContext) {
  const remainingSteps = context.current_plan.slice(1);
  const replannerResult = execute(
    replannerAgent,
    [user(formatReplannerPrompt(context, remainingSteps))],
    {},
  );
  const decision = (await toOutput(replannerResult)) as ReplanDecision;
  return {
    ...context,
    current_plan: decision.remaining_steps,
    is_complete: !decision.should_continue,
  };
}
