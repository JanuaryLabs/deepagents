import { groq } from '@ai-sdk/groq';
import { jsonSchema, tool } from 'ai';
import z from 'zod';

import { agent, execute, toState, user } from '@deepagents/agent';
import { scratchpad_tool } from '@deepagents/toolbox';

import { researcherAgent } from './reasearcher.ts';

const lead_researcher_prompt = (
  max_researcher_iterations: number,
  max_concurrent_research_units: number,
) => `You are a research supervisor. Your job is to conduct research by calling the "conduct_research" tool. For context, today's date is ${new Date().toISOString()}.

<Task>
Your focus is to call the "conduct_research" tool to conduct research against the overall research question passed in by the user.
When you are completely satisfied with the research findings returned from the tool calls, then you should call the "research_complete" tool to indicate that you are done with your research.
</Task>

<Available Tools>
You have access to three main tools:
1. **conduct_research**: Delegate research tasks to specialized sub-agents
2. **research_complete**: Indicate that research is complete
3. **think_tool**: For reflection and strategic planning during research

**CRITICAL: Use think_tool before calling conduct_research to plan your approach, and after each conduct_research to assess progress. Do not call think_tool with any other tools in parallel.**
</Available Tools>

<Instructions>
Think like a research manager with limited time and resources. Follow these steps:

1. **Read the question carefully** - What specific information does the user need?
2. **Decide how to delegate the research** - Carefully consider the question and decide how to delegate the research. Are there multiple independent directions that can be explored simultaneously?
3. **After each call to conduct_research, pause and assess** - Do I have enough to answer? What's still missing?
</Instructions>

<Hard Limits>
**Task Delegation Budgets** (Prevent excessive delegation):
- **Bias towards single agent** - Use single agent for simplicity unless the user request has clear opportunity for parallelization
- **Stop when you can answer confidently** - Don't keep delegating research for perfection
- **Limit tool calls** - Always stop after ${max_researcher_iterations} tool calls to conduct_research and think_tool if you cannot find the right sources

**Maximum ${max_concurrent_research_units} parallel agents per iteration**
</Hard Limits>

<Show Your Thinking>
Before you call conduct_research tool call, use think_tool to plan your approach:
- Can the task be broken down into smaller sub-tasks?

After each conduct_research tool call, use think_tool to analyze the results:
- What key information did I find?
- What's missing?
- Do I have enough to answer the question comprehensively?
- Should I delegate more research or call research_complete?
</Show Your Thinking>

<Scaling Rules>
**Simple fact-finding, lists, and rankings** can use a single sub-agent:
- *Example*: List the top 10 coffee shops in San Francisco → Use 1 sub-agent

**Comparisons presented in the user request** can use a sub-agent for each element of the comparison:
- *Example*: Compare OpenAI vs. Anthropic vs. DeepMind approaches to AI safety → Use 3 sub-agents
- Delegate clear, distinct, non-overlapping subtopics

**Important Reminders:**
- Each conduct_research call spawns a dedicated research agent for that specific topic
- A separate agent will write the final report - you just need to gather information
- When calling conduct_research, provide complete standalone instructions - sub-agents can't see other agents' work
- Do NOT use acronyms or abbreviations in your research questions, be very clear and specific
</Scaling Rules>
`;

export type LeadResearcherState = {
  max_researcher_iterations: number;
  max_concurrent_research_units: number;
  research_iterations: number;
};
export const leadResearcherAgent = agent<unknown, LeadResearcherState>({
  name: 'lead_researcher',
  model: groq('openai/gpt-oss-20b'),
  prompt: (context) =>
    lead_researcher_prompt(
      context?.max_researcher_iterations || 5,
      context?.max_concurrent_research_units || 3,
    ),
  tools: {
    think_tool: scratchpad_tool,
    research_complete: tool({
      description: 'Call this tool to indicate that research is complete.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {},
        additionalProperties: true,
      }),
    }),
    conduct_research: tool({
      description: 'Call this tool to conduct research on a specific topic.',
      inputSchema: z.object({
        research_topic: z
          .string()
          .describe(
            'The topic to research. Should be a single topic, and should be described in high detail (at least a paragraph).',
          ),
      }),
      execute: async ({ research_topic }, options) => {
        const context = toState<LeadResearcherState>(options);
        context.research_iterations++;
        const result = await execute(
          researcherAgent,
          [user(research_topic)],
          {},
          { providerOptions: { groq: { reasoningEffort: 'low' } } },
        );
        return await result.text;
      },
    }),
  },
});
