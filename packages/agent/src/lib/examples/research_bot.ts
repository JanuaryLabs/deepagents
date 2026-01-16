import { openai } from '@ai-sdk/openai';
import z from 'zod';

import { agent, instructions } from '../agent.ts';
import { input } from '../stream_utils.ts';
import { execute, generate } from '../swarm.ts';

const WebSearchPlanSchema = z.object({
  searches: z
    .array(
      z.object({
        reason: z
          .string()
          .describe(
            'Your reasoning for why this search is important to the query.',
          ),
        query: z
          .string()
          .describe('The search term to use for the web search.'),
      }),
    )
    .describe('A list of web searches to perform to best answer the query.'),
});

const ReportDataSchema = z.object({
  short_summary: z
    .string()
    .describe('A short 2-3 sentence summary of the findings.'),
  markdown_report: z.string().describe('The final report'),
  follow_up_questions: z
    .array(z.string())
    .describe('Suggested topics to research further'),
});

type WebSearchPlan = z.infer<typeof WebSearchPlanSchema>;
type ReportData = z.infer<typeof ReportDataSchema>;
type SearchResult = {
  query: string;
  reason: string;
  summary: string;
};

const planner = agent({
  model: openai('gpt-4.1'),
  name: 'PlannerAgent',
  handoffDescription: `A helpful agent that assists with planning tasks.`,
  output: WebSearchPlanSchema,
  prompt: instructions({
    purpose: [
      'You are a helpful research assistant. Given a query, come up with a set of web searches to perform to best answer the query.',
    ],
    routine: ['Output between 5 and 10 terms to query for.'],
  }),
});

const research = agent({
  model: openai.responses('gpt-4.1'),
  name: 'ResearchAgent',
  handoffDescription: `A helpful agent that assists with research tasks.`,
  prompt: instructions({
    purpose: [
      'You are a research assistant. Given a search term, you search the web for that term and produce a concise summary of the results.',
    ],
    routine: [
      'Capture the main points. Write succinctly, no need to have complete sentences or good grammar.',
      'This will be consumed by someone synthesizing a report, so its vital you capture the essence and ignore any fluff.',
      'Do not include any additional commentary other than the summary itself.',
    ],
  }),
  tools: {
    // browser_search: groq.tools.browserSearch({}),
    web_search: (openai as any).tools.webSearch({
      searchContextSize: 'low',
    }),
  },
});

const writer = agent({
  name: 'WriterAgent',
  model: openai('gpt-5'),
  handoffDescription: `A helpful agent that assists with writing tasks.`,
  output: ReportDataSchema,
  prompt: instructions({
    purpose: [
      'You are a senior researcher tasked with writing a cohesive report for a research query.',
      'You will be provided with the original query, and some initial research done by a research assistant.',
    ],
    routine: [
      'You should first come up with an outline for the report that describes the structure and flow of the report.',
      'Then, generate the report and return that as your final output.',
      'The final output should be in markdown format, and it should be lengthy and detailed.',
      'Aim for 5-10 pages of content, at least 1000 words.',
    ],
  }),
});

async function planSearches(query: string): Promise<WebSearchPlan> {
  console.log('Planning searches...');
  const { output } = await generate(planner, `Query: ${query}`, {});
  const plan = output as WebSearchPlan;
  console.log(`Will perform ${plan.searches.length} searches`);
  return plan;
}

async function performSearches(plan: WebSearchPlan) {
  console.log('Searching...');
  const results = await Promise.all(
    plan.searches.map(async (item) => {
      console.log(`Searching for: ${item.query}`);
      const input = `Search term: ${item.query}\nReason for searching: ${item.reason}`;
      const result = await execute(research, input, {});
      const text = await result.text;
      const sources = await result.sources;
      return {
        query: item.query,
        reason: item.reason,
        summary: text,
        sources,
      };
    }),
  );
  return results;
}

async function writeReport(
  query: string,
  searchResults: SearchResult[],
): Promise<ReportData> {
  console.log('Thinking about report...');
  const writerInput = `Original query: ${query}\nSummarized search results: ${JSON.stringify(searchResults)}`;
  const { output } = await generate(writer, writerInput, {});
  return output as ReportData;
}

async function run(query: string) {
  const plan = await planSearches(query);
  const searchResults = await performSearches(plan);
  console.log('\n\n=====SEARCH RESULTS=====\n');
  searchResults.forEach((it, index) => {
    console.log(`${index + 1}. ${it.query}`);
    console.log(`   Reason: ${it.reason}`);
    console.log(`   Summary: ${it.summary}`);
    it.sources.forEach((source) => {
      console.log(`SourceTitle`, source.title);
      if (source.sourceType === 'url') {
        console.log(`SourceUrl`, source.url);
      } else {
        console.log(`SourceFilename`, source.filename);
        console.log(`SourceMediaType`, source.mediaType);
      }
    });
    console.log('');
  });
  const report = await writeReport(query, searchResults);

  const finalReport = `Report summary\n\n${report.short_summary}`;
  console.log(finalReport);

  console.log('\n\n=====REPORT=====\n');
  console.log(`Report: ${report.markdown_report}`);
  console.log('\n\n=====FOLLOW UP QUESTIONS=====\n');
  console.log(`Follow up questions: ${report.follow_up_questions.join('\n')}`);
}

await run(await input());
