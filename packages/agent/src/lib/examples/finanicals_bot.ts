import { groq } from '@ai-sdk/groq';
import { type ListrTask } from 'listr2';
import z from 'zod';

import { type OutputExtractorFn, agent, instructions } from '../agent.ts';
import { input } from '../stream_utils.ts';
import { execute, generate } from '../swarm.ts';
import { createProgress, withMessageProgress } from './planner.ts';

const FinancialSearchItemSchema = z.object({
  reason: z
    .string()
    .describe('Your reasoning for why this search is relevant.'),
  query: z
    .string()
    .describe('The search term to feed into a web (or file) search.'),
});

const FinancialSearchPlanSchema = z.object({
  searches: z
    .array(FinancialSearchItemSchema)
    .describe('A list of searches to perform.'),
});

const AnalysisSummarySchema = z.object({
  summary: z
    .string()
    .describe('Short text summary for this aspect of the analysis.'),
});

const FinancialReportDataSchema = z.object({
  short_summary: z.string().describe('A short 2-3 sentence executive summary.'),
  markdown_report: z.string().describe('The full markdown report.'),
  follow_up_questions: z
    .array(z.string())
    .describe('Suggested follow-up questions for further research.'),
});

const VerificationResultSchema = z.object({
  verified: z
    .boolean()
    .describe('Whether the report seems coherent and plausible.'),
  issues: z
    .string()
    .describe('If not verified, describe the main issues or concerns.'),
});

type FinancialSearchPlan = z.infer<typeof FinancialSearchPlanSchema>;
type FinancialReportData = z.infer<typeof FinancialReportDataSchema>;
type VerificationResult = z.infer<typeof VerificationResultSchema>;
type AnalysisSummary = z.infer<typeof AnalysisSummarySchema>;

// Custom output extractor for sub-agents that return an AnalysisSummary
const summaryExtractor: OutputExtractorFn = async (result) => {
  // The financial/risk analyst agents emit an AnalysisSummary with a `summary` field.
  // We want the tool call to return just that summary text so the writer can drop it inline.
  return (result.output as AnalysisSummary).summary;
};

const plannerAgent = agent({
  name: 'FinancialPlannerAgent',
  model: groq('openai/gpt-oss-20b'),
  output: FinancialSearchPlanSchema,
  prompt: instructions({
    purpose: [
      'You are a financial research planner. Given a request for financial analysis, produce a set of web searches to gather the context needed.',
      'Aim for recent headlines, earnings calls or 10-K snippets, analyst commentary, and industry background.',
    ],
    routine: ['Output between 5 and 15 search terms to query for.'],
  }),
});

const riskAgent = agent({
  name: 'RiskAnalystAgent',
  model: groq('openai/gpt-oss-20b'),
  output: AnalysisSummarySchema,
  prompt: instructions({
    purpose: [
      "You are a risk analyst looking for potential red flags in a company's outlook.",
      'Given background research, produce a short analysis of risks such as competitive threats, regulatory issues, supply chain problems, or slowing growth.',
    ],
    routine: ['Keep it under 2 paragraphs.'],
  }),
});

const financialsAgent = agent({
  name: 'FundamentalsAnalystAgent',
  model: groq('openai/gpt-oss-20b'),
  output: AnalysisSummarySchema,
  prompt: instructions({
    purpose: [
      'You are a financial analyst focused on company fundamentals such as revenue, profit, margins and growth trajectory.',
      'Given a collection of web (and optional file) search results about a company, write a concise analysis of its recent financial performance.',
    ],
    routine: ['Pull out key metrics or quotes.', 'Keep it under 2 paragraphs.'],
  }),
});

const searchAgent = agent({
  name: 'FinancialSearchAgent',
  model: groq('openai/gpt-oss-20b'),
  prompt: instructions({
    purpose: [
      'You are a research assistant specializing in financial topics.',
      'Given a search term, use web search to retrieve up-to-date context and produce a short summary of at most 300 words.',
    ],
    routine: [
      'Focus on key numbers, events, or quotes that will be useful to a financial analyst.',
    ],
  }),
  toolChoice: 'required',
  tools: {
    browser_search: (groq as any).tools.browserSearch({}),
  },
});

const writerAgent = agent({
  name: 'FinancialWriterAgent',
  model: groq('openai/gpt-oss-20b'),
  output: FinancialReportDataSchema,
  prompt: instructions({
    purpose: [
      'You are a senior financial analyst. You will be provided with the original query and a set of raw search summaries.',
      'Your task is to synthesize these into a long-form markdown report (at least several paragraphs) including a short executive summary and follow-up questions.',
    ],
    routine: [
      'If needed, you can call the available analysis tools (e.g. fundamentals_analysis, risk_analysis) to get short specialist write-ups to incorporate.',
    ],
  }),
});

const verifierAgent = agent({
  name: 'VerificationAgent',
  model: groq('openai/gpt-oss-20b'),
  output: VerificationResultSchema,
  prompt: instructions({
    purpose: [
      'You are a meticulous auditor. You have been handed a financial analysis report.',
      'Your job is to verify the report is internally consistent, clearly sourced, and makes no unsupported claims.',
    ],
    routine: ['Point out any issues or uncertainties.'],
  }),
});

type Ctx = {
  plan?: FinancialSearchPlan;
  searchResults?: string[];
  report?: FinancialReportData;
  verification?: VerificationResult;
};

// ------ Entry Point ------ //

const query = await input();
const progress = createProgress<Ctx>();

progress.add({
  title: 'Planning searches',
  task: async (ctx, task) => {
    const { output } = await generate(plannerAgent, `Query: ${query}`, {});
    const plan = output as FinancialSearchPlan;
    ctx.plan = plan;
    task.title = `Planned ${plan.searches.length} searches`;
  },
});

progress.add({
  title: 'Searching the web',
  task: async (ctx, task) => {
    return task.newListr(
      ctx.plan!.searches.map(
        (item, idx) =>
          ({
            title: `🔍 ${item.query}`,
            rendererOptions: { persistentOutput: true },
            task: async (_subCtx, subTask) => {
              const result = await execute(
                searchAgent,
                `Search term: ${item.query}\nReason: ${item.reason}`,
                {},
              );
              ctx.searchResults ??= [];
              ctx.searchResults[idx] = await result.text;
              subTask.title = `${item.query}`;
            },
          }) satisfies ListrTask,
      ),
      {
        ctx,
        concurrent: true,
        exitOnError: false,
        rendererOptions: {
          collapseSubtasks: false,
          showSubtasks: true,
        },
      },
    );
  },
});

progress.add({
  title: 'Writing financial report',
  rendererOptions: { persistentOutput: true },
  task: async (ctx, task) => {
    const fundamentalsTool = financialsAgent.asTool({
      toolDescription: 'Use to get a short write-up of key financial metrics',
      outputExtractor: summaryExtractor,
    });
    const riskTool = riskAgent.asTool({
      toolDescription: 'Use to get a short write-up of potential red flags',
      outputExtractor: summaryExtractor,
    });

    const writerWithTools = writerAgent.clone({
      tools: {
        fundamentals_analysis: fundamentalsTool,
        risk_analysis: riskTool,
      },
    });

    task.output = '📝 Analyzing research data...';
    task.title = '📝 Writing financial report';

    const progressUpdater = withMessageProgress((message) => {
      task.output = `📝 ${message}`;
    });

    const { output } = await generate(
      writerWithTools,
      `Original query: ${query}\nSummarized search results: ${ctx.searchResults}`,
      {},
    );
    const report = output as FinancialReportData;

    progressUpdater[Symbol.dispose]?.();

    ctx.report = report;
    task.title = 'Financial report completed';
    task.output = `Report ready: ${report.short_summary.slice(0, 100)}...`;
  },
});

progress.add({
  title: 'Verifying report',
  rendererOptions: { persistentOutput: true },
  task: async (ctx: Ctx, task) => {
    task.output = '🔍 Checking report quality and consistency...';
    task.title = '🔍 Verifying report';

    const { output } = await generate(
      verifierAgent,
      ctx.report!.markdown_report,
      {},
    );
    const verification = output as VerificationResult;

    ctx.verification = verification;

    if (verification.verified) {
      task.title = 'Report verified';
      task.output = 'Report passed verification checks';
    } else {
      task.title = 'Report needs attention';
      task.output = `Issues found: ${verification.issues}`;
    }
  },
});

const ctx = await progress.run();

console.log('\n\n=====REPORT=====\n\n');
console.log(`Report:\n${ctx.report?.markdown_report}`);
console.log('\n\n=====FOLLOW UP QUESTIONS=====\n\n');
console.log(ctx.report?.follow_up_questions.join('\n'));
console.log('\n\n=====VERIFICATION=====\n\n');
console.log(ctx.verification);
