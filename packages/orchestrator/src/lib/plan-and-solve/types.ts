import z from 'zod';

/**
 * Schema for a single reasoning step in the plan
 */
export const ReasoningStepSchema = z.object({
  step_number: z.number().describe('The step number in the plan'),
  description: z
    .string()
    .describe('Description of what this step accomplishes'),
  reasoning: z.string().describe('The reasoning process for this step'),
  result: z
    .string()
    .optional()
    .describe('Intermediate result from this step if applicable'),
});

/**
 * Schema for the complete Plan-and-Solve Plus output
 */
export const PlanAndSolveOutputSchema = z.object({
  understanding: z
    .string()
    .describe(
      'Understanding of the problem - what is being asked and what information is needed',
    ),
  plan: z
    .array(z.string())
    .describe('List of subtasks needed to solve the problem'),
  variables: z
    .record(z.string(), z.any())
    .describe(
      'Extracted relevant variables and their corresponding values/numerals',
    ),
  reasoning_steps: z
    .array(ReasoningStepSchema)
    .describe('Step-by-step execution of the plan with reasoning'),
  calculations: z
    .array(
      z.object({
        expression: z.string().describe('The calculation expression'),
        result: z.union([z.string(), z.number()]).describe('The result'),
      }),
    )
    .optional()
    .describe('Any calculations performed with their results'),
  final_answer: z
    .union([z.string(), z.number()])
    .describe('The final answer to the problem'),
});

/**
 * Schema for self-consistency result
 */
export const SelfConsistencyResultSchema = z.object({
  answers: z
    .array(
      z.object({
        answer: z.union([z.string(), z.number()]),
        reasoning_path: z.string(),
        confidence: z.number().optional(),
      }),
    )
    .describe('All generated reasoning paths and their answers'),
  majority_answer: z
    .union([z.string(), z.number()])
    .describe('The most common answer across all paths'),
  confidence_score: z
    .number()
    .min(0)
    .max(1)
    .describe('Confidence score based on answer agreement (0-1)'),
  vote_distribution: z
    .record(z.string(), z.number())
    .describe('Distribution of votes for each unique answer'),
});

// Type exports
export type ReasoningStep = z.infer<typeof ReasoningStepSchema>;
export type PlanAndSolveOutput = z.infer<typeof PlanAndSolveOutputSchema>;
export type SelfConsistencyResult = z.infer<typeof SelfConsistencyResultSchema>;

/**
 * Input configuration for Plan-and-Solve Plus
 */
export interface PlanAndSolveConfig {
  /**
   * The problem/question to solve
   */
  problem: string;

  /**
   * Temperature for generation (0 for deterministic, 0.7 for self-consistency)
   * @default 0
   */
  temperature?: number;

  /**
   * Whether to use self-consistency (multiple reasoning paths)
   * @default false
   */
  useSelfConsistency?: boolean;

  /**
   * Number of reasoning paths to generate for self-consistency
   * @default 10
   */
  numPaths?: number;
}
