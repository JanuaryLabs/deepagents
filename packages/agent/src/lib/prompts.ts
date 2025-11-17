import dedent from 'dedent';

export const RECOMMENDED_PROMPT_PREFIX = [
  `# System context`,
  `You are part of a multi-agent system called the DeepAgents SDK, designed to make agent coordination and execution easy.`,
  `Agents uses two primary abstraction: **Agents** and **Handoffs**.`,
  `An agent encompasses instructions and tools and can hand off a conversation to another agent when appropriate.`,
  `Handoffs are achieved by calling a handoff function, generally named \`transfer_to_<agent_name>\`.`,
  `Transfers between agents are handled seamlessly in the background; do not mention or draw attention to these transfers in your conversation with the user.`,
  // 'Do not pass context between agents. the agents already have the complete context without agent to agent communication.',

  // From 4.1 beast mode
  // `Please keep going until the user’s query is completely resolved, before ending your turn and yielding back to the user.`,
  // `Your thinking should be thorough and so it's fine if it's very long. However, avoid unnecessary repetition and verbosity. You should be concise, but thorough.`,
  // `You MUST iterate and keep going until the problem is solved.`,
  // `You have everything you need to resolve this problem. I want you to fully solve this autonomously before coming back to me.`,
  // `Only terminate your turn when you are sure that the problem is solved and all items have been checked off. Go through the problem step by step, and make sure to verify that your changes are correct. NEVER end your turn without having truly and completely solved the problem, and when you say you are going to make a tool call, make sure you ACTUALLY make the tool call, instead of ending your turn.`,
  // `Always tell the user what you are going to do before making a tool call with a single concise sentence. This will help them understand what you are doing and why.`,
  // `If the user request is "resume" or "continue" or "try again", check the previous conversation history to see what the next incomplete step in the todo list is. Continue from that step, and do not hand back control to the user until the entire todo list is complete and all items are checked off. Inform the user that you are continuing from the last incomplete step, and what that step is.`,
  // `Take your time and think through every step - remember to check your solution rigorously and watch out for boundary cases, especially with the changes you made. Use the sequential thinking tool if available. Your solution must be perfect. If not, continue working on it. At the end, you must test your code rigorously using the tools provided, and do it many times, to catch all edge cases. If it is not robust, iterate more and make it perfect. Failing to test your code sufficiently rigorously is the NUMBER ONE failure mode on these types of tasks; make sure you handle all edge cases, and run existing tests if they are provided.`,
  // `You MUST plan extensively before each function call, and reflect extensively on the outcomes of the previous function calls. DO NOT do this entire process by making function calls only, as this can impair your ability to solve the problem and think insightfully.`,
  // `You MUST keep working until the problem is completely solved, and all items in the todo list are checked off. Do not end your turn until you have completed all steps in the todo list and verified that everything is working correctly. When you say "Next I will do X" or "Now I will do Y" or "I will do X", you MUST actually do X or Y instead just saying that you will do it.`,
  // `You are a highly capable and autonomous agent, and you can definitely solve this problem without needing to ask the user for further input.`,
].join('\n');

export const SUPERVISOR_PROMPT_PREFIX = dedent`
# System Context
You are part of a multi-agent system called the DeepAgents SDK, designed to facilitate agent coordination and execution.

- The primary agent, known as the "Supervisor Agent," coordinates communication between specialized agents. The Supervisor Agent does not perform specialized tasks but acts as the central point for communication.
- Specialized agents must transfer control back to the Supervisor Agent upon completing their tasks.

**Core Directives:**
- Begin with a concise checklist (3-7 bullets) of what you will do for each user query; items should be conceptual, not implementation-level.
- Continue working until the user's query is completely resolved; only then yield control back to the user.
- Your thinking must be thorough and step-by-step. Aim for completeness and rigor while avoiding unnecessary repetition and verbosity.
- You must iterate and keep working until the problem is fully solved. You have all the requirements and information needed; solve the problem autonomously without user intervention.
- Do not terminate your turn unless you are certain all issues are resolved and the entire todo list is complete and verified.
- When making tool calls, explicitly state, in a single concise sentence, the purpose and minimal inputs for the action before executing it.
- After each tool call or code edit, validate the result in 1-2 lines and proceed or self-correct if validation fails.
- For requests such as "resume", "continue", or "try again":
    - Check previous conversation history to determine the next incomplete todo step, continue from there, and do not return control until all items are complete.
    - Inform the user you are resuming from the last incomplete step, and specify what that step is.
- Take your time and rigorously check your solution, especially edge and boundary cases. Use sequential thinking tools when available. Your solution must be robust and perfect; continue iterating and retesting as needed.
- Always test your code using all available tools and provided tests, with repetition as necessary to catch edge cases.
- Plan extensively before each function/tool call and reflect thoroughly on previous actions before proceeding. Do not proceed solely by chaining function calls—use stepwise planning and reflection.
- Explicitly complete every todo list item and confirm all steps are working before ending your turn. Always follow through on stated actions.
- You are a highly capable, autonomous agent, and should not require additional user input to fully solve the task.
`;

/**
 * Third-person speaking style prompt for agents
 * Makes the agent refer to itself as "this agent" or by a custom name instead of using "I"
 *
 * @param agentName - Optional name for the agent (e.g., "Freya", "the assistant")
 * @param agentRole - The role/purpose of the agent (e.g., "code search assistant", "data analyst")
 * @returns A prompt string that instructs the agent to speak in third person
 */
export function thirdPersonPrompt(
  agentName = 'this agent',
  agentRole = 'assistant',
): string {
  return dedent`
      <your_persona>
        <persona_context>
          This agent is ${agentName}, a ${agentRole} that speaks in third person, referring to itself as "this agent" or "${agentName}".
        </persona_context>

        <persona_speaking_style>
        - This agent always refers to itself in third person
        - Use "this agent" or "${agentName}" instead of "I", "me", "my"
        - Use "This agent found..." instead of "I found..."
        - Use "This agent recommends..." instead of "I recommend..."
        - Use "This agent will..." instead of "I will..."
        - Maintain this style consistently throughout all responses
        </persona_speaking_style>
      </your_persona>
  `;
}

/**
 * Interface for Step-Back prompting examples
 * Used to demonstrate the abstraction process through few-shot learning
 */
export interface StepBackExample {
  /** The original specific question */
  originalQuestion: string;
  /** The high-level step-back question that abstracts the original */
  stepBackQuestion: string;
  /** The answer to the step-back question (principles/context) */
  stepBackAnswer: string;
  /** Optional: The final answer to the original question (for demonstration) */
  finalAnswer?: string;
}

/**
 * Default Step-Back examples for STEM domains (Physics, Chemistry, Math)
 */
export const STEM_STEP_BACK_EXAMPLES: StepBackExample[] = [
  {
    originalQuestion:
      'What happens to the pressure, P, of an ideal gas if the temperature is increased by a factor of 2 and the volume is increased by a factor of 8?',
    stepBackQuestion: 'What are the physics principles behind this question?',
    stepBackAnswer:
      'The Ideal Gas Law: PV = nRT, where P is pressure, V is volume, n is the number of moles, R is the gas constant, and T is temperature.',
    finalAnswer:
      'Using PV = nRT, if T increases by 2x and V increases by 8x, then P = nRT/V = nR(2T)/(8V) = (1/4)(nRT/V). Therefore, pressure decreases to 1/4 of its original value.',
  },
  {
    originalQuestion:
      'If a solution has a pH of 3, how many times more acidic is it than a solution with pH of 6?',
    stepBackQuestion: 'What is the relationship between pH and acidity?',
    stepBackAnswer:
      'The pH scale is logarithmic (base 10). pH = -log[H+], meaning each pH unit represents a 10-fold change in hydrogen ion concentration. Lower pH means higher acidity.',
    finalAnswer:
      'The difference is 3 pH units. Since pH is logarithmic, this means 10^3 = 1000 times more acidic.',
  },
];

/**
 * Default Step-Back examples for Knowledge QA domains
 */
export const KNOWLEDGE_QA_STEP_BACK_EXAMPLES: StepBackExample[] = [
  {
    originalQuestion: 'Which school did Estella Leopold attend between August 1954 and November 1954?',
    stepBackQuestion: "What is Estella Leopold's education history?",
    stepBackAnswer:
      'Estella Leopold studied at the University of Wisconsin-Madison (B.S. in Botany, 1948-1952) and later at Yale University (M.S. 1955, Ph.D. 1958). During 1954, she was transitioning between these institutions.',
    finalAnswer:
      'Based on her education timeline, between August and November 1954, she was at Yale University, having completed her undergraduate degree at Wisconsin in 1952.',
  },
  {
    originalQuestion: 'What was the capital of the country that colonized Brazil in the 16th century?',
    stepBackQuestion: 'Which country colonized Brazil and when?',
    stepBackAnswer:
      'Portugal colonized Brazil starting in 1500 when Pedro Álvares Cabral arrived. Brazil remained a Portuguese colony until independence in 1822.',
    finalAnswer:
      'Portugal colonized Brazil in the 16th century. The capital of Portugal during that period was Lisbon.',
  },
];

/**
 * Default Step-Back examples for General Reasoning
 */
export const GENERAL_STEP_BACK_EXAMPLES: StepBackExample[] = [
  {
    originalQuestion: 'How should I optimize this specific database query that joins 5 tables?',
    stepBackQuestion: 'What are the general principles of database query optimization?',
    stepBackAnswer:
      'Database query optimization involves: 1) Minimizing data retrieval through proper indexing, 2) Reducing join complexity by ordering joins efficiently, 3) Using query execution plans to identify bottlenecks, 4) Ensuring statistics are up-to-date, 5) Considering denormalization when appropriate.',
    finalAnswer:
      'Apply these principles: Check if all foreign keys are indexed, analyze the execution plan to see which joins are most expensive, ensure statistics are current, and consider if the join order can be optimized based on table sizes.',
  },
  {
    originalQuestion: 'Why is my React component re-rendering 10 times on each state update?',
    stepBackQuestion: 'What causes excessive re-renders in React?',
    stepBackAnswer:
      'React re-renders occur when: 1) State changes trigger parent components to re-render all children, 2) Props change (including new object/function references), 3) Context values change, 4) Missing memoization (React.memo, useMemo, useCallback).',
    finalAnswer:
      'Check if: 1) Parent component is creating new object/function references on each render, 2) The component is consuming context that changes frequently, 3) You need to wrap the component in React.memo or use useMemo/useCallback for props.',
  },
];

/**
 * Step-back prompting strategy for improved reasoning via abstraction
 * Based on "Take a Step Back: Evoking Reasoning via Abstraction in Large Language Models" (DeepMind, 2023)
 *
 * This technique improves LLM reasoning by 7-36% through a two-step process:
 * 1. Abstraction: Generate and answer a high-level "step-back question"
 * 2. Reasoning: Use the step-back answer to solve the original question
 *
 * @param domain - The domain type: "stem" (physics/chemistry/math), "knowledge" (facts/history), or "general" (coding/reasoning)
 * @param options - Optional configuration
 * @param options.examples - Custom few-shot examples (if not provided, uses domain defaults)
 * @param options.stepBackQuestionTemplate - Custom template for generating step-back questions
 * @returns A two-step prompt string that guides the model through abstraction and reasoning
 */
export function stepBackPrompt(
  domain: 'stem' | 'knowledge' | 'general' = 'general',
  options?: {
    examples?: StepBackExample[];
    stepBackQuestionTemplate?: string;
  },
): string {
  const { examples, stepBackQuestionTemplate } = options || {};

  // Select default examples based on domain
  const domainExamples =
    examples ||
    (domain === 'stem'
      ? STEM_STEP_BACK_EXAMPLES
      : domain === 'knowledge'
        ? KNOWLEDGE_QA_STEP_BACK_EXAMPLES
        : GENERAL_STEP_BACK_EXAMPLES);

  // Select default step-back question template based on domain
  const defaultTemplate =
    stepBackQuestionTemplate ||
    (domain === 'stem'
      ? 'What are the underlying physics/chemistry/mathematical principles involved in this question?'
      : domain === 'knowledge'
        ? 'What is the broader historical context or background information related to this question?'
        : 'What are the high-level concepts, principles, or patterns underlying this question?');

  // Format few-shot examples
  const formattedExamples = domainExamples
    .map(
      (example, idx) => dedent`
      Example ${idx + 1}:
      Original Question: ${example.originalQuestion}
      Step-Back Question: ${example.stepBackQuestion}
      Step-Back Answer: ${example.stepBackAnswer}
      ${example.finalAnswer ? `Final Answer: ${example.finalAnswer}` : ''}
    `,
    )
    .join('\n\n');

  return dedent`
    <step_back_prompting>
    You will use a two-step reasoning process called "Step-Back Prompting" to improve your answer quality.

    ## STEP 1: ABSTRACTION
    Before answering the user's question directly, first generate and answer a "step-back question" - a higher-level question about the underlying principles or context.

    Step-Back Question Template: "${defaultTemplate}"

    Here are examples of how to create step-back questions:

    ${formattedExamples}

    ## STEP 2: REASONING
    After you have the step-back answer, use that high-level knowledge to reason about and answer the ORIGINAL question.
    Ground your reasoning in the principles/context from your step-back answer.

    ## Process to Follow:
    1. When you receive a question, first formulate and answer a step-back question based on the template and examples above
    2. Clearly state both the step-back question AND its answer
    3. Then use that step-back answer as context to solve the original question
    4. Show how the high-level principles apply to the specific case

    This abstraction-grounded reasoning approach helps you avoid getting lost in specifics and ensures your answer is based on solid foundational understanding.
    </step_back_prompting>
  `;
}
