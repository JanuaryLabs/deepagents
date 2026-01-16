import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';

import {
  agent,
  execute,
  input,
  instructions,
  toState,
  user,
} from '@deepagents/agent';
import {
  fastembed,
  ingest,
  nodeSQLite,
  similaritySearch,
} from '@deepagents/retrieval';
import { pdfFile } from '@deepagents/retrieval/connectors';

const QueryPaperSchema = z.object({
  query: z.string().min(1).describe('The question to ask about the paper'),
});

const PaperSummarySchema = z.object({
  title: z.string().describe('Paper title'),
  abstract: z.string().describe('Paper abstract or overview'),
  main_contribution: z.string().describe('Main contribution of the paper'),
  methodology: z.string().describe('Key methodology or approach used'),
  key_results: z.string().describe('Main results and findings'),
  limitations: z
    .string()
    .optional()
    .describe('Limitations mentioned in the paper'),
  future_work: z.string().optional().describe('Future work suggestions'),
});

// ============================
// State Management
// ============================

interface ArxivAgentContext {
  pdf_url: string;
  store_path: string;
}

export async function queryArxivPaper(
  query: string,
  pdfUrl: string,
  storePath: string,
) {
  const results = await similaritySearch(query, {
    connector: pdfFile(pdfUrl),
    store: nodeSQLite(storePath, 384),
    embedder: fastembed(),
  });

  return results.slice(0, 5).map((r) => r.content);
}

const queryPaperTool = tool({
  description:
    'Query the ingested arXiv paper using semantic search. Returns relevant sections from the paper.',
  inputSchema: QueryPaperSchema,
  execute: async ({ query }, options) => {
    const context = toState<ArxivAgentContext>(options);
    try {
      const results = await queryArxivPaper(
        query,
        context.pdf_url,
        context.store_path,
      );

      if (results.length === 0) {
        return 'No relevant information found in the paper.';
      }

      const formattedResults = results
        .map(
          (r, i) =>
            `[Chunk ${i + 1}] (similarity: ${r.similarity.toFixed(3)})\n${r.content}\n`,
        )
        .join('\n---\n\n');

      return formattedResults;
    } catch (error) {
      return `Error querying paper: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  },
});

// ============================
// Agents
// ============================

const summarizerAgent = agent({
  name: 'paper_summarizer',
  model: openai('gpt-4.1-nano'),
  output: PaperSummarySchema,
  prompt: instructions({
    purpose: [
      'You are a research paper analyst.',
      'Given relevant sections from an academic paper, extract and summarize key information.',
    ],
    routine: [
      'Read through the provided paper sections carefully',
      'Extract the title, abstract, main contribution, methodology, key results, and any limitations',
      'If certain sections are not available, infer from context or leave blank',
      'Return a structured summary following the schema',
    ],
  }),
});

export const arxivAgent = agent<unknown, ArxivAgentContext>({
  name: 'arxiv_researcher',
  model: openai('gpt-4o'),
  prompt: instructions({
    purpose: [
      'You are an arXiv research assistant.',
      'You help users analyze academic papers by ingesting PDFs and answering questions about them.',
    ],
    routine: [
      'Answer questions about the paper using the query_paper tool to find relevant sections',
      'Synthesize information from multiple chunks to provide comprehensive answers',
      'When asked for a summary, gather relevant information and provide a structured overview',
    ],
  }),
  tools: {
    query_paper: queryPaperTool,
  },
});

// ============================
// Interactive Example
// ============================

if (import.meta.main) {
  console.log('<� ArXiv Research Assistant\n');

  // Get PDF URL from user
  const pdfUrl = await input('https://arxiv.org/pdf/2103.00020.pdf');
  const url = pdfUrl.trim();

  console.log(`\nUsing URL: ${url}\n`);

  // Initialize context
  const context: ArxivAgentContext = {
    pdf_url: url,
    store_path: './arxiv_papers.db',
  };

  console.log('\nPaper ready for questions!\n');
  console.log('Example questions:');
  console.log('  - What is the main contribution of this paper?');
  console.log('  - Explain the methodology used');
  console.log('  - What are the key results?');
  console.log('  - What are the limitations mentioned?\n');

  // Interactive Q&A loop
  while (true) {
    const question = await input('\nYour question (or "quit" to exit): ');

    if (
      question.toLowerCase() === 'quit' ||
      question.toLowerCase() === 'exit'
    ) {
      console.log('\n=K Goodbye!');
      break;
    }

    if (!question.trim()) {
      continue;
    }

    console.log('\n> Searching paper...\n');

    const results = await queryArxivPaper(question, url, context.store_path);

    if (results.length === 0) {
      console.log('L No relevant information found.\n');
      continue;
    }

    const answer = (
      await execute(
        arxivAgent,
        [
          user(
            `Based on these sections from the paper, answer: ${question}\n\nSections:\n${results.map((r) => r.content).join('\n\n')}`,
          ),
        ],
        context,
      )
    ).text;

    console.log(`\n=� Answer:\n${answer}\n`);
  }
}
