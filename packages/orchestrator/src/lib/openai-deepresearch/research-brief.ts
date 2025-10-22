import { groq } from '@ai-sdk/groq';
import z from 'zod';

import { agent, execute, generate, toOutput } from '@deepagents/agent';

const transform_messages_into_research_topic_prompt = `You will be given a set of messages that have been exchanged so far between yourself and the user.
Your job is to translate these messages into a more detailed and concrete research question that will be used to guide the research.

You will return a single research question that will be used to guide the research.

Guidelines:
1. Maximize Specificity and Detail
- Include all known user preferences and explicitly list key attributes or dimensions to consider.
- It is important that all details from the user are included in the instructions.

2. Fill in Unstated But Necessary Dimensions as Open-Ended
- If certain attributes are essential for a meaningful output but the user has not provided them, explicitly state that they are open-ended or default to no specific constraint.

3. Avoid Unwarranted Assumptions
- If the user has not provided a particular detail, do not invent one.
- Instead, state the lack of specification and guide the researcher to treat it as flexible or accept all possible options.

4. Use the First Person
- Phrase the request from the perspective of the user.

5. Sources
- If specific sources should be prioritized, specify them in the research question.
- For product and travel research, prefer linking directly to official or primary websites (e.g., official brand sites, manufacturer pages, or reputable e-commerce platforms like Amazon for user reviews) rather than aggregator sites or SEO-heavy blogs.
- For academic or scientific queries, prefer linking directly to the original paper or official journal publication rather than survey papers or secondary summaries.
- For people, try linking directly to their LinkedIn profile, or their personal website if they have one.
- If the query is in a specific language, prioritize sources published in that language.
`;

export const ResearchTopic = z.object({
  research_brief: z
    .string()
    .describe('A research question that will be used to guide the research.'),
});

export const researchTopicAgent = agent({
  name: 'transform_messages_into_research_topic',
  model: groq('openai/gpt-oss-120b'),
  prompt: transform_messages_into_research_topic_prompt,
  output: ResearchTopic,
});

export async function transformMessagesIntoResearchTopic(userQuery: string) {
  const { experimental_output: output } = await generate(
    researchTopicAgent,
    `
			Today's date is ${new Date().toISOString()}.

The messages that have been exchanged so far between yourself and the user are:
User Query: ${userQuery}
			`,
    {},
  );
  return output;
}
