import { groq } from '@ai-sdk/groq';
import z from 'zod';

import {
  agent,
  execute,
  generate,
  lmstudio,
  printer,
  toOutput,
} from '@deepagents/agent';

const clarify_with_user_instructions = `
Today's date is ${new Date().toISOString()}.

Assess whether you need to ask a clarifying question, or if the user has already provided enough information for you to start research.
IMPORTANT: If you can see in the messages history that you have already asked a clarifying question, you almost always do not need to ask another one. Only ask another question if ABSOLUTELY NECESSARY.

If there are acronyms, abbreviations, or unknown terms, ask the user to clarify.
If you need to ask a question, follow these guidelines:
- Be concise while gathering all necessary information
- Make sure to gather all the information needed to carry out the research task in a concise, well-structured manner.
- Use bullet points or numbered lists if appropriate for clarity. Make sure that this uses markdown formatting and will be rendered correctly if the string output is passed to a markdown renderer.
- Don't ask for unnecessary information, or information that the user has already provided. If you can see that the user has already provided the information, do not ask for it again.

Respond in valid JSON format with these exact keys:
"need_clarification": boolean,
"question": "<question to ask the user to clarify the report scope>",
"verification": "<verification message that we will start research>"

If you need to ask a clarifying question, return:
"need_clarification": true,
"question": "<your clarifying question>",
"verification": ""

If you do not need to ask a clarifying question, return:
"need_clarification": false,
"question": "",
"verification": "<acknowledgement message that you will now start research based on the provided information>"

For the verification message when no clarification is needed:
- Acknowledge that you have sufficient information to proceed
- Briefly summarize the key aspects of what you understand from their request
- Confirm that you will now begin the research process
- Keep the message concise and professional
`;

export const ClarrifyQuestion = z.object({
  need_clarification: z
    .boolean()
    .describe('Whether the user needs to be asked a clarifying question.'),
  question: z
    .string()
    .describe('A question to ask the user to clarify the report scope'),
  verification: z
    .string()
    .describe(
      'Verify message that we will start research after the user has provided the necessary information.',
    ),
});

export const clarrifyAgent = agent({
  name: 'clarify_with_user',
  // model: lmstudio('qwen/qwen3-4b-thinking-2507'),
  model: groq('openai/gpt-oss-20b'),
  prompt: clarify_with_user_instructions,
  output: ClarrifyQuestion,
});

export async function clarrifyUserQuery(state: any, query: string) {
  const { experimental_output: output } = await generate(
    clarrifyAgent,
    `User Query: ${query}.
						Today's date is ${new Date().toISOString()}.`,
    state,
  );
  return output;
}
