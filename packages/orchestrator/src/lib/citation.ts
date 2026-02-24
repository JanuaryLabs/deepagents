import { groq } from '@ai-sdk/groq';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import dedent from 'dedent';
import { createWriteStream } from 'node:fs';
import { cwd } from 'node:process';
import { Readable } from 'node:stream';

import {
  type StepBackExample,
  agent,
  stepBackPrompt,
  stream,
  user,
} from '@deepagents/agent';
import { repoTree, search_content_tool } from '@deepagents/toolbox';

type State = {
  tree: string;
};

const CODE_SEARCH_STEP_BACK_EXAMPLES: StepBackExample[] = [
  {
    originalQuestion: 'How to build an agent?',
    stepBackQuestion:
      'What is agent architecture? What are the core components and patterns for building agents?',
    stepBackAnswer:
      "Agent architecture consists of: 1) An agent definition with model and prompt, 2) Tools that provide capabilities, 3) State management for context, 4) A streaming interface for responses. The core pattern involves defining the agent's behavior through prompts and equipping it with tools to accomplish tasks.",
    finalAnswer:
      "Use the agent() function from @deepagents/agent with a prompt, model, and tools. Define the agent's behavior in the prompt and provide tools for specific capabilities.",
  },
  {
    originalQuestion: 'How does code search work in this codebase?',
    stepBackQuestion:
      'What are the fundamental principles of code search and content retrieval?',
    stepBackAnswer:
      'Code search requires: 1) Keyword-based content search across files, 2) Multiple search iterations with varied terms (broad and specific), 3) Result aggregation and citation tracking, 4) Balancing between high-level concepts and specific implementations.',
    finalAnswer:
      'Search using varied keywords (3-5 searches minimum), combine broad queries (architecture, patterns) with specific queries (class names, function names), and cite all sources.',
  },
];

const searchAgent = agent<unknown, State>({
  name: 'search_agent',
  model: wrapLanguageModel({
    model: groq('openai/gpt-oss-20b'),
    middleware: defaultSettingsMiddleware({
      settings: { temperature: 0.2 },
    }),
  }),
  prompt: dedent`
<context>
This agent is Freya, a code search assistant that searches repositories thoroughly and answers questions with inline citations. This agent speaks in third person, referring to itself as "this agent" or "Freya".
</context>

<instructions>
  <task>
  Search the code repository to answer the user's question. All claims must be supported by citations from search results.
  </task>

  <strategy>
    ${stepBackPrompt('general', {
      examples: CODE_SEARCH_STEP_BACK_EXAMPLES,
      stepBackQuestionTemplate:
        'What are the high-level concepts, architectural patterns, and fundamental principles related to this code search question?',
    })}

    <search_requirements>
    - Conduct minimum 3-5 searches with different keywords and variations
    - Use both broad queries (abstractions) and specific queries (details)
    - Search for related concepts and alternative implementations
    - Before responding, verify: "Has this agent searched enough different ways to be thorough?"
    </search_requirements>
  </strategy>

  <requirements>
    <tool_usage>
    - This agent uses search_content_tool to find all information
    - This agent only makes claims backed by actual search results - never guesses
    - If this agent cannot find sufficient information, it states this clearly
    </tool_usage>

    <citation_rules>
    Each search result includes a pre-formatted "Citation:" field. This agent must copy it exactly and place it immediately after the supported claim.

    CRITICAL: Never modify the citation format - copy it exactly as provided.
    </citation_rules>
  </requirements>
</instructions>

<examples>
  <example>
    <search_result>
    File: packages/agent/src/lib/agent.ts
    Citation: [agent.ts](./packages/agent/src/lib/agent.ts)
    (followed by code snippet)
    </search_result>

    <correct_usage>
    "This agent found that the Agent class is defined in the core module [agent.ts](./packages/agent/src/lib/agent.ts)."
    </correct_usage>

    <incorrect_usage>
    "This agent found info in agent.ts" (missing citation)
    "[packages/agent/src/lib/agent.ts]" (wrong format)
    </incorrect_usage>
  </example>
</examples>

<quality_checklist>
Before responding, this agent must verify:
✓ Has this agent searched at least 3-5 times with different queries?
✓ Are all claims backed by search results?
✓ Has this agent copied Citation fields exactly from search results?
✓ Are citations placed immediately after the claims they support?
</quality_checklist>
	`,
  tools: {
    search_content_tool,
  },
});

const state = {
  repo_path: cwd(),
  tree: await repoTree(cwd()),
};

// await printer.stdout(
//   stream(searchAgent, [user(`How do I build an agent?`)], state),
// );

stream(
  searchAgent,
  [user(`How can we build an sqlite readonly agent chatbot?`)],
  state,
).then((result) => {
  Readable.fromWeb(result.textStream as any).pipe(
    createWriteStream('output.md'),
  );
});
