import { groq } from '@ai-sdk/groq';
import { openai } from '@ai-sdk/openai';
import { uniqBy } from 'lodash-es';
import { readFile, writeFile } from 'node:fs/promises';
import z from 'zod';

import { agent, execute, generate, lmstudio } from '@deepagents/agent';
import { fastembed, nodeSQLite, similaritySearch } from '@deepagents/retrieval';
import * as connectors from '@deepagents/retrieval/connectors';

const searchQueryAgent = agent({
  name: 'search-query-generator',
  model: groq('openai/gpt-oss-20b'),
  prompt: [
    `You are an expert research assistant. Given the user's query, generate up to four distinct, precise SEMANTIC search queries well-suited for a vector database of repository content (code, docs, comments).`,
    `Rules: (1) Do NOT include file paths, globs, regex, repository names, or line numbers. (2) Avoid repeating the same idea; ensure diversity (architecture, data flow, services, APIs, domain terms). (3) Keep each query concise (3–10 words). (4) Prefer concept-level phrasing over filenames.`,
    'Return only the queries as plain strings; no numbering or extra commentary.',
  ],
  output: z.object({ items: z.array(z.string()).max(4) }),
});

const repoContextAgent = agent({
  name: 'repo-context-summarizer',
  model: groq('openai/gpt-oss-20b'),
  prompt: [
    'You are an expert codebase analyst. You will receive samples from a repository (file paths with short content snippets).',
    'Produce a concise context summary capturing: primary domains, major modules/components, key data models, important services/APIs, external integrations, and notable terminology or patterns.',
    'Format as short markdown sections with bullet points. Keep under 400 words. Do not speculate beyond the provided snippets.',
  ],
});

const newSearchQueriesAgent = agent({
  name: 'research-continuation-planner',
  model: groq('openai/gpt-oss-120b'),
  prompt:
    'You are an analytical research assistant. Based on the original query, the search queries performed so far, and the extracted contexts, determine if further research is needed.',
  output: z.object({
    needsMoreResearch: z
      .boolean()
      .describe('Whether additional research is needed'),
    newQueries: z
      .array(z.string())
      .max(4)
      .describe(
        'Up to four new search queries if more research is needed, empty array otherwise',
      ),
    reasoning: z
      .string()
      .optional()
      .describe('Brief explanation of the decision'),
  }),
});

const pageUsefulnessAgent = agent({
  name: 'page-usefulness-evaluator',
  model: lmstudio('qwen/qwen3-4b-2507'),
  prompt: [
    'You are a strict and concise evaluator of research relevance.',
    "Given the user's query and the content of a repository file, determine if the file contains information relevant and useful for addressing the query.",
    "Respond with exactly one word: 'Yes' if the file is useful, or 'No' if it is not.",
  ],
  output: z.object({ answer: z.enum(['Yes', 'No']) }),
});

const extractRelevantContextAgent = agent({
  name: 'relevant-context-extractor',
  model: groq('openai/gpt-oss-20b'),

  prompt: [
    'You are an expert in extracting and summarizing relevant information.',
    "Given the user's query, the search query that led to this page, and the file content, extract all pieces of information that are relevant to answering the user's query.",
    'Return only the relevant context as plain text without commentary.',
  ],
});

const finalReportAgent = agent({
  name: 'final-report-writer',
  model: openai('gpt-4.1'),
  prompt: `You are an expert product manager that is working on reversing existing product to user stories based on a developer question/inquiry. Based on the gathered contexts below and the original query, write a comprehensive, well-structured, and detailed report that addresses the query thoroughly.\nInclude all relevant insights and conclusions without extraneous commentary.`,
});

async function generateSearchQueries(
  input: string,
  repoContext: string,
): Promise<string[]> {
  const { experimental_output: output } = await generate(
    searchQueryAgent,
    `User Query: ${input}\n\nRepository Context Summary:\n${repoContext}`,
    {},
  );
  return uniqBy(
    (output.items ?? []).map((s) => s.trim()).filter(Boolean),
    (s) => s.toLowerCase(),
  );
}

async function retrieve(query: string) {
  const results = await similaritySearch(query, {
    connector: connectors.repo(
      '/Users/ezzabuzaid/Desktop/mo/virtual-care',
      ['.ts', '.tsx', '.md', '.prisma'],
      'never',
    ),
    store: nodeSQLite('deepsearch.sqlite', 384),
    embedder: fastembed(),
  });
  return results.map((it) => ({
    snippet: it.content,
    source: it.document_id,
    similarity: it.similarity,
  }));
}

export async function getNewSearchQueries(
  userQuery: string,
  previousSearchQueries: string[],
  allContexts: string[],
  repoContext: string,
): Promise<string[]> {
  const contextCombined = allContexts.join('\n\n');
  const prompt = `User Query: ${userQuery}

Previous Search Queries: ${JSON.stringify(previousSearchQueries)}

Extracted Relevant Contexts:
${contextCombined}

Repository Context Summary:
${repoContext}

Based on the above information, determine if further research is needed. If yes, provide up to four new search queries. If the research is complete and sufficient, indicate that no more research is needed.`;

  try {
    const { experimental_output: output } = await generate(
      newSearchQueriesAgent,
      prompt,
      {},
    );

    if (!output.needsMoreResearch) {
      console.log(
        'Research assessment: No further research needed.',
        output.reasoning,
      );
      return [];
    }

    console.log(
      `Research assessment: ${output.newQueries.length} new queries generated.`,
      output.reasoning,
    );
    return uniqBy(output.newQueries.map((s) => s.trim()).filter(Boolean), (s) =>
      s.toLowerCase(),
    );
  } catch (error) {
    console.error('Error generating new search queries:', error);
    return [];
  }
}

export async function generateFinalReport(
  userQuery: string,
  formatting: string,
  allContexts: string[],
): Promise<string> {
  const contextCombined = allContexts.join('\n\n');
  const prompt = `
Developer Query: ${userQuery}
Formatting: ${formatting}

Gathered Relevant Contexts:
${contextCombined}`;

  return execute(finalReportAgent, prompt, {}).text;
}

async function isPageUseful(userQuery: string, pageText: string) {
  const prompt = `User Query: ${userQuery}\n\nRepo file content\n\n${pageText}\n\nDecide if the page is useful.`;
  const {
    experimental_output: { answer },
  } = await generate(pageUsefulnessAgent, prompt, {} as const);
  return answer === 'Yes';
}

async function extractRelevantContext(
  userQuery: string,
  searchQuery: string,
  pageText: string,
): Promise<string> {
  const prompt = `User Query: ${userQuery}\nSearch Query: ${searchQuery}\n\nRepo file content\n\n${pageText}\n\nExtract the relevant context.`;
  return execute(extractRelevantContextAgent, prompt, {} as const).text;
}

async function processFile(
  filePath: string,
  userQuery: string,
  searchQuery: string,
): Promise<{ source: string; content: string } | null> {
  const content = await readFile(filePath, 'utf-8');
  const useful = await isPageUseful(userQuery, content);
  if (useful) {
    return {
      source: filePath,
      content: await extractRelevantContext(userQuery, searchQuery, content),
    };
  }
  return null;
}

async function gatherRepoContext(): Promise<string> {
  const seeds = [
    'project overview',
    'backend',
    'framework',
    'hono express',
    'architecture',
    'services',
    'prisma',
    'database',
    'data model',
    'payments',
    'billing',
  ];
  const results = await Promise.all(seeds.map((it) => retrieve(it)));
  const deduped = uniqBy(results.flat(), (it) => it.source);
  const bundle = deduped
    .map((r, i) => `(${i + 1}) Path: ${r.source}\nSnippet:\n${r.snippet}`)
    .join('\n\n---\n\n');

  const summary = await execute(
    repoContextAgent,
    `Repository Samples (path + snippet):\n\n${bundle}\n\nSummarize as requested.`,
    {},
  ).text;
  return summary;
}

function search() {
  const cache: Record<string, Awaited<ReturnType<typeof retrieve>>> = {};
  const processedSources = new Set<string>();
  return async (queries: string[]) => {
    const results: Awaited<ReturnType<typeof retrieve>>[] = [];
    for (const query of queries) {
      if (!cache[query]) {
        const res = await retrieve(query);
        cache[query] = uniqBy(res, (it) => it.source);
      }
      results.push(cache[query]);
    }
    const uniqueLinks: Record<string, string> = {};
    for (let i = 0; i < results.length; i++) {
      const query = queries[i];
      for (const item of results[i]) {
        if (!uniqueLinks[item.source] && !processedSources.has(item.source)) {
          uniqueLinks[item.source] = query;
          processedSources.add(item.source);
        }
      }
    }
    return uniqueLinks;
  };
}

if (import.meta.main) {
  const userQuery = 'How do we process payment?';

  const formatting = `
1. use ascii markdown diagrams to illustrate. I am visual learner and I love markdown.
2. use "user stories" to illustrate flows. we are not looking for only text or techical explanation.
3. user story scenario should be divided by actors and steps.
4. when referencing code snippets, include file path.
`;

  const iterLimit = 2;
  const aggregatedContexts: string[] = [];
  const allSearchQueries: string[] = [];
  let iteration = 0;
  const repoContext = await gatherRepoContext();
  let searchQueriesResult = await generateSearchQueries(userQuery, repoContext);
  const performSearch = search();

  while (iteration < iterLimit) {
    const iterationContexts: string[] = [];

    allSearchQueries.push(...searchQueriesResult);
    const searchResults = await performSearch(searchQueriesResult);

    await Promise.all(
      Object.entries(searchResults).map(async ([source, query]) => {
        const context = await processFile(source, userQuery, query);
        if (context) {
          iterationContexts.push(
            `Source: ${context.source}\n\nContent: ${context.content}\n\n`,
          );
        }
      }),
    );

    if (iterationContexts.length === 0) {
      console.log('No useful contexts were found in this iteration.');
    } else {
      aggregatedContexts.push(...iterationContexts);
    }

    searchQueriesResult = await getNewSearchQueries(
      userQuery,
      allSearchQueries,
      aggregatedContexts,
      repoContext,
    );
    if (searchQueriesResult.length === 0) {
      console.log('No further research needed. Exiting loop.');
      break;
    } else {
      allSearchQueries.push(...searchQueriesResult);
    }

    iteration += 1;
  }

  console.log('\nGenerating final report...');
  console.log('Search queries performed:', allSearchQueries);
  const finalReport = await generateFinalReport(
    userQuery,
    formatting,
    aggregatedContexts,
  );

  await writeFile('final_report.md', finalReport);
}
