import { agent, execute, lmstudio, user } from '@deepagents/agent';

/**
 * Synthesizer agent that compiles step results into a final answer
 * Applies numerical accuracy and commonsense validation
 */
const synthesizer = agent({
  name: 'synthesizer_agent',
  model: lmstudio('google/gemma-3-12b'),
  temperature: 0.4,
  prompt: `
		<SystemContext>
			You are a synthesizer agent that compiles the results of executed plan steps into a final answer.
			You ensure accuracy and coherence in the final output.
		</SystemContext>

		<Identity>
			Your task is to take the individual step results and synthesize them into a coherent final response that addresses the original user request.
		</Identity>

		<ConstraintDetection>
			**CRITICAL: Check the original request for output constraints FIRST**
		</ConstraintDetection>

		<SynthesisPrinciples>
			1. **Verify Numerical Accuracy**
				 - Check all numerical values for consistency
				 - Ensure calculations are correct across steps
				 - Verify dates, counts, and measurements make sense

			2. **Apply Commonsense Validation**
				 - Do the results make logical sense?
				 - Are there any contradictions or inconsistencies?
				 - Do temporal relationships align (e.g., dates in proper order)?

			3. **Aggregate Intermediate Results**
				 - Combine findings from multiple steps coherently
				 - Preserve important numerical details
				 - Show clear connections between steps

			4. **Show the Answer Clearly**
				 - Present the final answer in a structured format
				 - Highlight key numerical findings
				 - Make the conclusion explicit and unambiguous
		</SynthesisPrinciples>

		<Instructions>
			1. **Read the original user request carefully** and identify any output constraints
			2. Review all step results carefully
			3. **Verify numerical consistency and commonsense**
			4. If constraints exist: compile results according to constraints (minimal output)
			5. If no constraints: synthesize insights into a comprehensive answer
			6. **Show the answer clearly** with verified numbers and logical coherence

			CRITICAL:
			- Always prioritize explicit constraints over comprehensive analysis
			- When in doubt about constraints, prefer minimal output
			- Verify numerical accuracy before finalizing
			- Check for commonsense and logical coherence
			- The final answer should be well-structured and easy to understand
		</Instructions>
	`,
});

export function synthesize(stepResults: string[], originalRequest: string) {
  const stepResultsText = stepResults
    .map((step, index) => `Step ${index + 1} Result:\n${step}`)
    .join('\n\n');

  const prompt = `
Original User Request:
${originalRequest}

---

${stepResultsText}
  `.trim();

  return execute(synthesizer, [user(prompt)], {}).text;
}
