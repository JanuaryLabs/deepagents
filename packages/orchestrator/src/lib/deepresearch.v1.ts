import { groq } from '@ai-sdk/groq';
import { openai } from '@ai-sdk/openai';
import { tavily } from '@tavily/core';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';

import { agent, execute, generate, input, user } from '@deepagents/agent';

export interface SearchEntry {
  title: string;
  url: string;
  content: string;
  query: string;
}

export interface ParagraphResearchState {
  searchHistory: SearchEntry[]; // appended chronologically
  latestSummary: string; // evolving synthesized paragraph content
  reflectionIteration: number; // count of reflection loops executed
}

export interface ParagraphPlan {
  title: string;
  content: string; // planned description / intent for the paragraph
  research: ParagraphResearchState;
}

export interface ResearchState {
  reportTitle: string;
  paragraphs: ParagraphPlan[];
}

function dedupeSearchEntries(entries: SearchEntry[]): SearchEntry[] {
  const seen = new Set<string>();
  const result: SearchEntry[] = [];
  for (const e of entries) {
    const key = `${e.query}::${e.url ?? e.title}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(e);
    }
  }
  return result;
}

const OutlineOutputSchema = z.object({
  reportTitle: z.string().min(5),
  sections: z
    .array(
      z.object({
        title: z.string().min(1),
        content: z.string().min(1),
      }),
    )
    .min(1)
    .max(30),
});

const outlineAgent = agent({
  name: 'outline-planner',
  model: groq('openai/gpt-oss-20b'),
  prompt: [
    'You are a Deep Research assistant. Given the USER QUERY, plan a structured report outline.',
    'Return ONLY valid JSON (array of objects) matching the provided schema with paragraph title and content description.',
    'Do not include code fences, commentary or reasoning, just JSON.',
  ],
  output: OutlineOutputSchema,
});

const FirstSearchOutputSchema = z.object({
  search_query: z.string().min(2),
  reasoning: z.string().optional(),
});

const firstSearchPlannerAgent = agent({
  name: 'first-search-planner',
  model: groq('openai/gpt-oss-20b'),
  prompt: `You are a Deep Research assistant. Given the USER QUERY plus paragraph title and initial content, craft ONE optimal web search query to collect factual, current information. Return only JSON {"search_query": string, "reasoning": string}.`,
  output: FirstSearchOutputSchema,
});

const ReflectionSearchOutputSchema = z.object({
  search_query: z.string().min(2),
  reasoning: z.string().optional(),
});

const reflectionSearchPlannerAgent = agent({
  name: 'reflection-search-planner',
  model: groq('openai/gpt-oss-20b'),
  prompt: [
    'You enrich a paragraph through iterative research. Provided JSON includes the USER QUERY, paragraph title, planned content, and the current drafted summary.',
    'Identify a missing angle, fact, statistic, counterpoint, timeline, cause/effect, or recent development.',
    'Return ONLY JSON {"search_query": string, "reasoning": string}. If no enrichment needed, use an empty string for search_query.',
  ],
  output: ReflectionSearchOutputSchema,
});

const ParagraphSummaryOutputSchema = z.object({
  paragraph_latest_state: z.string().min(20),
});

const paragraphSummaryAgent = agent({
  name: 'paragraph-summarizer',
  model: openai('gpt-4.1-mini'),
  prompt: [
    'You are producing a polished paragraph for a research report. Input JSON provides: USER QUERY, title, planned content, search_query used, and an array of textual snippets (search_results).',
    'Integrate facts cohesively, avoid fluff, cite NO sources inline, keep within ~250 words, maintain factual tone.',
    'Return ONLY JSON {"paragraph_latest_state": string}.',
  ],
  output: ParagraphSummaryOutputSchema,
});

const finalReportAgent = agent<{ userQuery: string }>({
  name: 'final_report',
  model: openai('gpt-4.1'),
  prompt: (context) => `
		You have finalized paragraphs of a research report as JSON array [{title, paragraph_latest_state}].
    Produce a well-structured Markdown report with: top-level title, table of contents, each section with heading, and a concluding synthesis (add Conclusion if missing).
    Do not hallucinate new sections beyond conclusion. Keep formatting clean.
  `,
});

type OutlineOutput = z.infer<typeof OutlineOutputSchema>;

async function planOutline(userQuery: string) {
  const { output } = await generate(
    outlineAgent,
    `USER QUERY: ${userQuery}`,
    {},
  );
  const result = output as OutlineOutput;
  return {
    reportTitle: result.reportTitle,
    paragraphs: result.sections.map(
      (p: { title: string; content: string }) => ({
        title: p.title.trim(),
        content: p.content.trim(),
        research: {
          latestSummary: '',
          reflectionIteration: 0,
          searchHistory: [],
        },
      }),
    ),
  } satisfies ResearchState;
}

type FirstSearchOutput = z.infer<typeof FirstSearchOutputSchema>;

async function planFirstSearch(userQuery: string, paragraph: ParagraphPlan) {
  const { output } = await generate(
    firstSearchPlannerAgent,
    [
      user(
        `USER QUERY: ${userQuery}\nTitle: ${paragraph.title}\nContent: ${paragraph.content}`,
      ),
    ],
    { userQuery },
  );
  return output as FirstSearchOutput;
}

type ReflectionSearchOutput = z.infer<typeof ReflectionSearchOutputSchema>;

async function planReflectionSearch(
  userQuery: string,
  paragraph: ParagraphPlan,
) {
  const { output } = await generate(
    reflectionSearchPlannerAgent,
    `USER QUERY: ${userQuery}\n${JSON.stringify({
      title: paragraph.title,
      content: paragraph.content,
      paragraph_latest_state: paragraph.research.latestSummary,
    })}`,
    { userQuery },
  );
  return output as ReflectionSearchOutput;
}

async function summarizeParagraph(
  userQuery: string,
  paragraph: ParagraphPlan,
  searchQuery: string,
  snippets: string[],
) {
  const input = {
    user_query: userQuery,
    title: paragraph.title,
    content: paragraph.content,
    search_query: searchQuery,
    search_results: snippets.slice(0, 8),
  };
  type ParagraphSummaryOutput = z.infer<typeof ParagraphSummaryOutputSchema>;
  const { output } = await generate(
    paragraphSummaryAgent,
    [
      user(
        `
				USER QUERY: ${userQuery}
				Title: ${input.title}
				Content: ${input.content}
				Search Query: ${input.search_query}
				Search Results: ${input.search_results.join('\n\n---\n\n')}
				`,
      ),
    ],
    { userQuery },
  );
  const out = output as ParagraphSummaryOutput;
  paragraph.research.latestSummary = out.paragraph_latest_state.trim();
}

async function runWebSearch(query: string) {
  const tvly = tavily();
  const response = await tvly.search(query);
  return response.results.map(
    (r) =>
      ({
        query,
        url: r.url,
        title: r.title,
        content: r.content,
      }) satisfies SearchEntry,
  );
}

function collectAllSnippets(p: ParagraphPlan): string[] {
  return p.research.searchHistory
    .map((h) => h.content?.trim())
    .filter((s): s is string => !!s);
}

export interface ResearchOptions {
  maxReflections?: number; // per paragraph
  stopOnDuplicateQuery?: boolean;
}

const defaultResearchOptions: Required<ResearchOptions> = {
  maxReflections: 2,
  stopOnDuplicateQuery: true,
};

export async function researchParagraph(
  userQuery: string,
  paragraph: ParagraphPlan,
  options: ResearchOptions = {},
) {
  const opts = { ...defaultResearchOptions, ...options };
  const firstPlan = await planFirstSearch(userQuery, paragraph);
  console.log(`\n=== Researching Paragraph: ${paragraph.title} ===`);
  console.log(
    `Search Query: ${firstPlan.search_query} with reasoning: ${firstPlan.reasoning}`,
  );
  const firstQuery = firstPlan.search_query?.trim();
  if (!firstQuery) return;
  const firstResults = await runWebSearch(firstQuery);
  paragraph.research.searchHistory.push(...firstResults);
  paragraph.research.searchHistory = dedupeSearchEntries(
    paragraph.research.searchHistory,
  );
  await summarizeParagraph(
    userQuery,
    paragraph,
    firstQuery,
    collectAllSnippets(paragraph),
  );

  // Reflection loop
  while (paragraph.research.reflectionIteration < opts.maxReflections) {
    const reflection = await planReflectionSearch(userQuery, paragraph);
    const rq = reflection.search_query?.trim();
    if (!rq) break; // model decided no more
    const alreadyUsed = paragraph.research.searchHistory.some(
      (h) => h.query.toLowerCase() === rq.toLowerCase(),
    );
    if (alreadyUsed && opts.stopOnDuplicateQuery) break;

    const refResults = await runWebSearch(rq);
    paragraph.research.searchHistory.push(...refResults);
    paragraph.research.searchHistory = dedupeSearchEntries(
      paragraph.research.searchHistory,
    );
    paragraph.research.reflectionIteration += 1;
    await summarizeParagraph(
      userQuery,
      paragraph,
      rq,
      collectAllSnippets(paragraph),
    );
  }
}

export async function deepresearch(
  userQuery: string,
  options: ResearchOptions = {},
): Promise<{ state: ResearchState; markdown: string }> {
  const state = await planOutline(userQuery);
  for (let i = 0; i < state.paragraphs.length; i++) {
    await researchParagraph(userQuery, state.paragraphs[i], options);
  }
  const reportData = state.paragraphs.map((p) => ({
    title: p.title,
    paragraph_latest_state: p.research.latestSummary,
  }));
  const result = await execute(
    finalReportAgent,
    [
      user(
        `User Query: ${userQuery}\nFormatting: use ascii markdown diagrams to illustrate. I am visual learner and I love markdown.\nContext: ${reportData.join('\n\n')}`,
      ),
    ],
    { userQuery },
  );
  const finalReportMd = await result.text;
  return { state, markdown: finalReportMd };
}

if (import.meta.main) {
  const userQuery = await input(
    'How to integrates planning modules from whitepaper like LLM Compiler, plan and solve, plan and act and others into building deepresearch agent?',
  );
  const { state, markdown } = await deepresearch(userQuery, {
    maxReflections: 1,
  });
  const outfile = `deepresearch_report.md`;
  await writeFile(outfile, markdown, 'utf8');
  console.dir(state, { depth: null });
}
