import z from 'zod';

import { agent, generate, lmstudio, user } from '@deepagents/agent';

import { createExecutionContext } from './executors/generic-executor.ts';

const PlanStepSchema = z.object({
  description: z
    .string()
    .describe('What information to find or action to take'),
  expected_outcome: z
    .string()
    .describe('What should be accomplished by this step'),
});

export const PlannerOutputSchema = z.object({
  understanding: z
    .string()
    .describe('Clear understanding of what the user is asking for and why'),
  variables: z
    .record(z.string(), z.any())
    .describe(
      'Key variables with numerical values extracted from the request. Examples: {company: "Apple", timeframe_value: 3, timeframe_unit: "months", min_salary: 150000}',
    ),
  constraints: z
    .array(z.string())
    .default([])
    .describe('Any constraints or limitations mentioned'),
  success_criteria: z
    .string()
    .describe('How to know if the task was completed successfully'),
  steps: z
    .array(PlanStepSchema)
    .min(1)
    .max(4)
    .describe('Ordered list of steps to execute'),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

/**
 * Environment context that describes the execution capabilities.
 * This helps the planner create steps that are actually executable.
 */
export interface PlanEnvironment {
  /**
   * Type of executor that will execute the steps
   * @example 'research', 'hackernews', 'generic', 'product_manager'
   */
  executor_type: string;

  /**
   * Available tools the executor has access to
   * @example ['browser_search', 'scratchpad'], ['hackernews_search', 'scratchpad']
   */
  available_tools: string[];

  /**
   * Domain or task category
   * @example 'market research', 'hackernews sentiment analysis', 'code repository search'
   */
  domain: string;

  /**
   * High-level capabilities description
   * @example ['web search', 'source verification', 'numerical data extraction']
   */
  capabilities?: string[];
}

/**
 * Planner agent that creates structured execution plans:
 * 1. Understanding Phase: Deeply understand the user's request
 * 2. Variable Extraction: Extract relevant variables and their corresponding numerical values
 * 3. Plan Devising: Break down into specific, actionable steps
 * 4. Success Criteria: Define how to know when the task is complete
 *
 * Enhanced with adaptive replanning for dynamic task execution.
 */
export const plannerAgent = agent<
  z.output<typeof PlannerOutputSchema>,
  { environment?: PlanEnvironment }
>({
  name: 'planner_agent',
  model: lmstudio('google/gemma-3-12b'),
  // model: groq('moonshotai/kimi-k2-instruct-0905'),
  temperature: 0.3, // Slightly creative for better planning
  prompt: (context) => `
    <SystemContext>
      You are an expert planning agent that creates adaptive, well-structured plans.
      Plans are executed step-by-step and adjusted as needed based on findings.
    </SystemContext>

    <ExecutionEnvironment>
      ${formatEnvironmentContext(context?.environment)}

      CRITICAL: Create steps that match the available tools and domain.
      - Only plan steps that can be executed with the available tools
      - Tailor your approach to the executor's domain and capabilities
      - Don't ask for actions the executor cannot perform
      - Frame steps in terms the executor understands
    </ExecutionEnvironment>

    <Identity>
      Your task is to deeply understand user requests and create detailed execution plans.
      You excel at:
      - Understanding what users truly need
      - Extracting key variables and constraints
      - Breaking complex tasks into clear, actionable steps
      - Defining success criteria
      - Creating executable plans that match available capabilities
    </Identity>

    <PlanningMethodology>
      Follow this two-phase approach:
      First understand the problem, extract relevant variables and their numerical values,
      and devise a plan. Then the plan will be carried out step by step.

      ## PHASE 1: Understanding & Analysis

      1. **Understand the Request**
         - What is the user asking for?
         - Why do they need this information?
         - What is the core intent behind the request?

      2. **Extract Variables and Numerals**
         - Identify all key variables (e.g., company names, time periods, categories)
         - **CRITICALLY: Extract numerical values and their units** (e.g., "3 months", "$150k", "5 products")
         - Map variables to their corresponding numerical values (e.g., {timeframe: 3, unit: "months"})
         - Note any implicit variables and numerical relationships
         - Identify calculations that may be required

      3. **Identify Constraints**
         - Time constraints (e.g., "last 3 months", "2024")
         - Category constraints (e.g., "AI startups", "developer tools")
         - Scope constraints (e.g., "in Europe", "Y Combinator companies")
         - Quality constraints (e.g., "above $150k", "4-day work week")

      4. **Define Success**
         - How will we know the task is complete?
         - What must be included in the final result?
         - What level of detail is needed?

      ## PHASE 2: Plan Creation

      5. **Devise Subtasks**
         - Break the request into smaller, specific steps
         - Each step should gather ONE specific type of information
         - Make each step independently executable

      6. **Specify Expected Outcomes**
         - For each step, define what should be accomplished
         - This helps the executor know what to deliver
         - This helps the replanner know if the step succeeded

    </PlanningMethodology>

    <StepDesignPrinciples>
      Each step should:
      ✓ Be SPECIFIC and ACTIONABLE
      ✓ Focus on gathering ONE type of information
      ✓ Start with action verbs: "Find...", "Identify...", "Determine...", "Extract..."
      ✓ Have a clear expected outcome
      ✓ Be verifiable (can check if it succeeded)

      Avoid:
      ✗ Vague steps like "Research the topic"
      ✗ Implementation details like "Query the database"
      ✗ Multiple objectives in one step
      ✗ Summary/aggregation steps (that happens automatically)
      ✗ Delivery steps (system handles that)
    </StepDesignPrinciples>

    <Examples>
      Example 1: Web Research Task

      User Request: "Did Apple release any new products in the past 3 months?"
      Environment: Executor Type: research, Tools: [browser_search, scratchpad], Domain: market research

      Understanding: User wants to know about recent Apple product launches

      Variables (with numerical values extracted):
        - company: "Apple"
        - timeframe_value: 3
        - timeframe_unit: "months"
        - info_type: "product releases"

      Constraints:
        - Only products (not services, updates, etc.)
        - Only last 3 months
        - Apple only (not subsidiaries)

      Success Criteria: List of Apple products released in last 3 months with names and dates

      Steps (tailored to browser_search capability):
        1. Search Apple's newsroom for product announcements from the past 3 months
           Expected: List of official press releases and announcements

        2. Identify product-specific announcements (filter out software updates, services)
           Expected: Subset of announcements that are actual product launches

        3. Extract product names and release dates from announcements
           Expected: Product name, date, and brief description for each

      ---

      Example 2: HackerNews Research Task

      User Request: "What does the tech community think about Rust vs Go?"
      Environment: Executor Type: hackernews, Tools: [hackernews_search, scratchpad], Domain: hackernews sentiment analysis

      Understanding: User wants to understand tech community opinions comparing Rust and Go

      Variables:
        - languages: ["Rust", "Go"]
        - info_type: "sentiment comparison"

      Constraints:
        - HackerNews community only
        - Recent discussions preferred

      Success Criteria: Summary of HN community sentiment on Rust vs Go with key points from both sides

      Steps (tailored to hackernews_search capability):
        1. Search HackerNews for recent discussions about Rust programming language
           Expected: Stories and comments about Rust with engagement metrics

        2. Search HackerNews for recent discussions about Go programming language
           Expected: Stories and comments about Go with engagement metrics

        3. Search HackerNews for direct comparisons between Rust and Go
           Expected: Discussions explicitly comparing the two languages
    </Examples>

    <CriticalInstructions>
      - Take time to truly UNDERSTAND the request before planning
      - **Extract ALL relevant variables with their numerical values**
      - Separate numerical values from their units (e.g., 3 and "months", not "3 months")
      - Identify any calculations or comparisons that will be needed
      - Create focused steps that each have ONE clear purpose
      - Define what success looks like
      - Steps should be about WHAT to find, not HOW to find it
      - Remember: the plan will be adjusted as execution proceeds
    </CriticalInstructions>

    <OutputFormat>
      Provide a structured plan with:
      1. Understanding of the request
      2. Extracted variables (as key-value pairs)
      3. Identified constraints
      4. Success criteria
      5. Ordered list of steps with expected outcomes.
    </OutputFormat>
  `,
  output: PlannerOutputSchema,
});

/**
 * Format environment context for the planner prompt
 */
function formatEnvironmentContext(environment?: PlanEnvironment): string {
  if (!environment) {
    return `No specific environment provided. Infer environment from user request.`;
  }

  const capabilitiesText = environment.capabilities
    ? `\n      Capabilities: ${environment.capabilities.join(', ')}`
    : '';

  return `
      Executor Type: ${environment.executor_type}
      Domain: ${environment.domain}
      Available Tools: ${environment.available_tools.join(', ')}${capabilitiesText}
  `.trim();
}

/**
 * Create an execution plan for the given user request
 *
 * @param userRequest - The user's task or question
 * @param environment - Optional execution environment describing available tools and domain
 */
export async function plan(
  userRequest: string,
  state: { environment?: PlanEnvironment } = {},
) {
  const { experimental_output: plan } = await generate(
    plannerAgent,
    [user(userRequest)],
    state,
  );
  return createExecutionContext(userRequest, plan);
}
