import { type UIMessage, generateId } from 'ai';

import { execute, printer, user } from '@deepagents/agent';

import {
  type LeadResearcherState,
  leadResearcherAgent,
} from './lead-research.ts';

// let clarification: z.output<typeof ClarrifyQuestion> = {
//   need_clarification: true,
//   question: '',
//   verification: '',
// };
// const messages: UIMessage[] = [];
// while (clarification.need_clarification) {
//   console.log(clarification.question + '\n');
//   messages.push(user(await input()));
//   const result = execute(clarrifyAgent, messages, {});
//   const output = await toOutput<z.output<typeof ClarrifyQuestion>>(result);
//   await Array.fromAsync(
//     result.toUIMessageStream({
//       generateMessageId: generateId,
//       originalMessages: messages,
//       onFinish: async ({ responseMessage }) => {
//         messages.push(responseMessage);
//       },
//     }),
//   );
//   await result.consumeStream();
//   clarification = output;
// }
// const { research_brief } = await toOutput<z.output<typeof ResearchTopic>>(
//   execute(researchTopicAgent, clarification.verification, {}),
// );
const research_brief = `I want a comprehensive research report on opening a coworking space in Amman, Jordan that includes detailed market insights (size, growth trends, target demographics, and demand drivers), a competitor analysis (existing coworking providers, their locations, pricing models, amenities, and market share), an assessment of demand and pricing elasticity, key operational considerations (optimal locations, regulatory and licensing requirements, staffing needs, technology and infrastructure, cost structure, revenue projections, and risk factors), and actionable recommendations for a go‑to‑market strategy. Any dimensions not explicitly specified (e.g., preferred target customer segment, budget constraints, or timeline) should be treated as open‑ended and explored broadly.`;

printer.stdout(
  execute(leadResearcherAgent, [user(research_brief)], {
    max_concurrent_research_units: 3,
    max_researcher_iterations: 3,
    research_iterations: 0,
  }),
  { reasoning: false },
);

// await startResearch(research_brief);

async function startResearch(brief: string) {
  const messages: UIMessage[] = [user(brief)];
  const state: LeadResearcherState = {
    max_concurrent_research_units: 3,
    max_researcher_iterations: 1,
    research_iterations: 0,
  };
  while (true) {
    const result = execute(leadResearcherAgent, messages, state);
    await Array.fromAsync(
      result.toUIMessageStream({
        generateMessageId: generateId,
        originalMessages: messages,
        onFinish: async ({ responseMessage }) => {
          messages.push(responseMessage);
        },
      }),
    );
    await result.consumeStream();
    const calls = await result.toolCalls;
    const researchComplete = calls.some(
      (it) => it.toolName === 'research_complete',
    );
    const conductResearchTools = calls.filter(
      (it) => it.toolName === 'conduct_research',
    );

    const exceeded_allowed_iterations =
      state.research_iterations >= state.max_researcher_iterations;

    if (researchComplete || exceeded_allowed_iterations || !calls.length) {
      break;
    }

    // for (const call of conductResearchTools) {
    //   const result = execute(
    //     researcherAgent,
    //     [user(call.input.research_topic)],
    //     {},
    //   );
    //   const mostRecentMessage = messages[messages.length - 1];
    //   if (mostRecentMessage.role === 'assistant') {
    //     messages.push({
    //       role: 'assistant',
    //       // parts: [{}],
    //     });
    //   }
    // }

    state.research_iterations++;
  }
}
