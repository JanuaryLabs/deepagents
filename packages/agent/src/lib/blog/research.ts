import { groq } from '@ai-sdk/groq';
import { dynamicTool, generateText } from 'ai';
import z from 'zod';

import { type Handoffs, agent, instructions } from '../agent.ts';

export const RESEARCH_SYSTEM_PROMPT = `
You are a research agent specialized in finding and synthesizing information from the web.
Your job is to conduct thorough research and provide comprehensive, accurate analysis.
Use strategic search approaches: start wide, then narrow down to specific details.
`.trim();

const researchTool = dynamicTool({
  description:
    'Conduct web research with strategic search approach - start broad, then narrow focus',
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        'The research query - use broad terms initially, then specific terms',
      ),
    approach: z
      .enum(['broad', 'specific', 'targeted'])
      .default('broad')
      .describe(
        'Search approach: broad for initial exploration, specific for detailed investigation, targeted for precise facts',
      ),
    focusAreas: z
      .array(z.string())
      .optional()
      .describe('Specific areas to focus research on within the query topic'),
    maxSources: z
      .number()
      .min(1)
      .max(3)
      .default(3)
      .describe('Maximum number of sources to investigate'),
  }),
  execute: async (input) => {
    const { query, approach, focusAreas, maxSources } = input as {
      query: string;
      approach: 'broad' | 'specific' | 'targeted';
      focusAreas?: string[];
      maxSources: number;
    };

    try {
      // Apply Anthropic's "start wide, then narrow down" principle
      const searchPrompt =
        approach === 'broad'
          ? `Research broadly: ${query}. Start with general exploration to understand the landscape, then identify key areas for deeper investigation.`
          : approach === 'specific'
            ? `Research specifically: ${query}${focusAreas ? `. Focus on: ${focusAreas.join(', ')}` : ''}. Provide detailed analysis with current data and examples.`
            : `Find targeted information: ${query}. Look for precise facts, statistics, and specific details.`;

      console.log({ searchPrompt });

      const { text } = await generateText({
        model: groq('openai/gpt-oss-120b'),
        prompt: `${searchPrompt}

Research Guidelines:
- Use multiple search strategies to ensure comprehensive coverage
- Prioritize authoritative sources over SEO-optimized content
- Include current statistics and real examples where possible
- Identify gaps in available information
- Return structured findings with clear source attribution

Maximum ${maxSources} sources. Return comprehensive analysis with key findings.`,
        tools: {
          browser_search: (groq as any).tools.browserSearch({}),
        },
        toolChoice: 'required',
        providerOptions: {
          groq: {
            structuredOutputs: false,
            reasoningEffort: 'low',
          },
        },
      });

      return {
        findings: text,
        approach: approach,
        query: query,
        focusAreas: focusAreas,
      };
    } catch (error) {
      return {
        error: `Research failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        fallback:
          'Unable to perform web research. Please try a different query or check your connection.',
        suggestions: [
          'Try breaking down the query into smaller, more specific questions',
          'Use broader search terms if the topic is too narrow',
          'Check if the information might be available in specialized databases',
        ],
      };
    }
  },
});

export const researchAgent = <C>(handoffs: Handoffs<C>) =>
  agent({
    model: groq('openai/gpt-oss-20b'),
    name: 'research_agent',
    handoffDescription:
      'A research agent that conducts comprehensive web research and provides structured analysis',
    prompt: instructions.supervisor_subagent({
      purpose: [
        'You are a professional research agent following strategic research methodology.',
        'Conduct thorough research using a systematic approach: explore the landscape, then drill into specifics.',
        'Evaluate source quality and prioritize authoritative information over generic content.',
        'Provide comprehensive analysis with clear attribution and structured findings.',
      ],
      routine: [
        'RESEARCH STRATEGY: Start with broad exploration, then progressively narrow focus.',
        'FIRST: Use research tool with "broad" approach to understand the topic landscape.',
        'EVALUATE: Assess initial findings and identify key areas requiring deeper investigation.',
        'SECOND: Use research tool with "specific" approach for detailed analysis of important areas.',
        'OPTIONAL: Use "targeted" approach for precise facts or statistics if needed.',
        'SYNTHESIZE: Combine findings into comprehensive analysis in <research></research> tags.',
        'INCLUDE: Source quality assessment, gaps in available information, and confidence levels.',
        'STRUCTURE: Organize findings with clear headings, bullet points, and source attribution.',
        'produce the results in <research></research> tag.',
        'transfer_to_manager_agent when research is complete',
      ],
    }),
    tools: {
      research: researchTool,
    },
    handoffs,
  });
