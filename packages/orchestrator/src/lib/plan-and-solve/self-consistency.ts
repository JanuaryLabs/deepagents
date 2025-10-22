import { execute, toOutput, user } from '@deepagents/agent';

import { createPlanAndSolveAgent } from './plan-and-solve-agent.ts';
import type { PlanAndSolveOutput, SelfConsistencyResult } from './types.ts';

/**
 * Implements self-consistency for Plan-and-Solve Plus
 *
 * Self-consistency improves reasoning by:
 * 1. Generating multiple diverse reasoning paths (with temperature > 0)
 * 2. Extracting the final answer from each path
 * 3. Selecting the most consistent answer via majority voting
 *
 * Based on the paper's configuration:
 * - Temperature: 0.7 (for diversity)
 * - Number of paths: 10 (default, configurable)
 */
export async function planAndSolveWithSelfConsistency(
  problem: string,
  numPaths = 10,
): Promise<SelfConsistencyResult> {
  console.log(
    `\nGenerating ${numPaths} reasoning paths with self-consistency...\n`,
  );

  // Create agent with temperature=0.7 for diverse reasoning paths
  const agent = createPlanAndSolveAgent(0.7);

  // Generate multiple reasoning paths in parallel
  const reasoningPaths = await Promise.all(
    Array.from({ length: numPaths }, async (_, index) => {
      console.log(`Generating reasoning path ${index + 1}/${numPaths}...`);

      try {
        const result = execute(agent, [user(problem)], {});
        const output = (await toOutput(result)) as PlanAndSolveOutput;

        // Extract the final answer and reasoning
        return {
          answer: output.final_answer,
          reasoning_path: JSON.stringify(output, null, 2),
          understanding: output.understanding,
          plan: output.plan,
          reasoning_steps: output.reasoning_steps,
        };
      } catch (error) {
        console.error(`Error in path ${index + 1}:`, error);
        return null;
      }
    }),
  );

  // Filter out failed paths
  const validPaths = reasoningPaths.filter(
    (path): path is NonNullable<typeof path> => path !== null,
  );

  if (validPaths.length === 0) {
    throw new Error('Failed to generate any valid reasoning paths');
  }

  console.log(
    `\nSuccessfully generated ${validPaths.length} valid reasoning paths\n`,
  );

  // Perform majority voting
  const answerCounts = new Map<string, number>();
  validPaths.forEach((path) => {
    // Normalize answer for comparison (convert to string and trim)
    const normalized = String(path.answer).trim().toLowerCase();
    answerCounts.set(normalized, (answerCounts.get(normalized) || 0) + 1);
  });

  // Find the most common answer
  let majorityAnswer = '';
  let maxCount = 0;

  for (const [answer, count] of answerCounts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      majorityAnswer = answer;
    }
  }

  // Find the original (non-normalized) version of the majority answer
  const originalMajorityAnswer =
    validPaths.find(
      (path) => String(path.answer).trim().toLowerCase() === majorityAnswer,
    )?.answer || majorityAnswer;

  // Calculate confidence score (agreement percentage)
  const confidenceScore = maxCount / validPaths.length;

  // Create vote distribution
  const voteDistribution: Record<string, number> = {};
  for (const [answer, count] of answerCounts.entries()) {
    voteDistribution[answer] = count;
  }

  // Display results
  console.log('\n=== Self-Consistency Results ===');
  console.log(`Total paths: ${validPaths.length}`);
  console.log(`Majority answer: ${originalMajorityAnswer}`);
  console.log(
    `Confidence: ${(confidenceScore * 100).toFixed(1)}% (${maxCount}/${validPaths.length} paths agree)`,
  );
  console.log('\nVote distribution:');
  for (const [answer, count] of Object.entries(voteDistribution)) {
    const percentage = ((count / validPaths.length) * 100).toFixed(1);
    console.log(`  ${answer}: ${count} votes (${percentage}%)`);
  }
  console.log('================================\n');

  return {
    answers: validPaths.map((path) => ({
      answer: path.answer,
      reasoning_path: path.reasoning_path,
    })),
    majority_answer: originalMajorityAnswer,
    confidence_score: confidenceScore,
    vote_distribution: voteDistribution,
  };
}

/**
 * Analyzes the diversity of reasoning paths
 * Useful for understanding how different the generated paths are
 */
export function analyzeReasoningDiversity(results: SelfConsistencyResult): {
  uniqueAnswers: number;
  entropy: number;
  diversityScore: number;
} {
  const distribution = results.vote_distribution;
  const total = results.answers.length;

  // Calculate Shannon entropy
  let entropy = 0;
  for (const count of Object.values(distribution)) {
    const p = count / total;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  // Diversity score: 0 (all same) to 1 (all different)
  const uniqueAnswers = Object.keys(distribution).length;
  const maxEntropy = Math.log2(total);
  const diversityScore = maxEntropy > 0 ? entropy / maxEntropy : 0;

  return {
    uniqueAnswers,
    entropy,
    diversityScore,
  };
}
