import { openai } from '@ai-sdk/openai';

import { defineAgent } from '@deepagents/experimental/zukhruf';

import instructions from './instructions.ts';
import sandbox from './sandbox.ts';
import { planner } from './subagents/planner.ts';
import { researcher } from './subagents/researcher.ts';

/**
 * Subagents-as-tools: the planner and researcher are normal `agent()`s, wired
 * into the root as tools via `agent.asTool()`. `asTool()` returns tool results
 * by default (empty for a subagent that calls no tools), so both pass an
 * `outputExtractor` to hand back the subagent's text (and, for research, its
 * sources).
 */
export default defineAgent({
  name: 'ResearchBot',
  model: openai('gpt-5'),
  sandbox,
  instructions,
  tools: {
    plan_searches: planner.asTool({
      toolDescription:
        'Delegate to the planner. Pass the research query as `input`; returns 5–10 web searches to run.',
      outputExtractor: (result) => result.text,
    }),
    research: researcher.asTool({
      toolDescription:
        'Delegate to the web researcher. Pass one search term and why it matters as `input`; returns a concise summary with sources.',
      outputExtractor: (result) => {
        const sources = (result.sources ?? []).map((source) =>
          source.sourceType === 'url'
            ? `- ${source.title ?? source.url} — ${source.url}`
            : `- ${source.title ?? ''}`,
        );
        return sources.length
          ? `${result.text}\n\nSources:\n${sources.join('\n')}`
          : result.text;
      },
    }),
  },
});
