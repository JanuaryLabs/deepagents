import { groq } from '@ai-sdk/groq';
import { type UIMessage, generateId, tool } from 'ai';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import z from 'zod';
import { th } from 'zod/v4/locales';

import {
  agent,
  execute,
  generate,
  instructions,
  lmstudio,
  toOutput,
  toState,
  user,
} from '@deepagents/agent';
import { scratchpad_tool } from '@deepagents/toolbox';

import {
  file_exists_tool,
  read_dir_tool,
  read_file_tool,
  search_files_tool,
} from './tools.ts';

const BaseOutlineItem = z.object({
  title: z.string().trim().min(1, 'Title is required'),
});
type OutlineItem = z.output<typeof BaseOutlineItem> & {
  sections?: z.output<typeof OutlineItemSchema>[];
};
const OutlineItemSchema: z.ZodType<OutlineItem> = z.lazy(() =>
  BaseOutlineItem.extend({
    sections: z.array(OutlineItemSchema).optional(),
  }),
);
const OutlineSchema = z.array(OutlineItemSchema);
export type Outline = z.output<typeof OutlineSchema>;
export type OutlineAgentContext = {
  repo_path: string;
  outline: z.output<typeof OutlineSchema>;
  scratchpad: string;
  tree: string;
};

export const outlineAgent = agent<unknown, OutlineAgentContext>({
  name: 'Outline Agent',
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  // model: lmstudio('qwen/qwen3-8b'),
  // model: lmstudio('openai/gpt-oss-20b'),

  // temperature: 0.1,
  prompt: (context) =>
    instructions({
      purpose: [
        "You are wiki architect, meticulously analyzing a repository's structure and content to automatically generate a comprehensive, intelligent, and perfectly structured outline, laying the bedrock for exceptional documentation.",
        '\n',
        '<RepositoryTree>',
        context?.tree || '',
        '</RepositoryTree>',
      ],
      routine: [],
      // routine: [
      //   'Your primary tool for memory is your `scratchpad`. After every action, you MUST summarize your findings and add them to the scratchpad using the `update_scratchpad` tool.',
      //   'Systematically investigate key files and directories use `search_files`. For each finding add it as a new note to your scratchpad.',
      //   'When you read a file like `README.md` or `package.json`, do not keep the whole content in your head. Instead, summarize the important parts (like headings, dependencies, or scripts) and add that summary to your scratchpad.',
      //   'Continue this process of exploring, summarizing, and adding to your scratchpad until you are confident you have a full picture of the repository.',
      //   'Once you believe you have gathered enough information, your second-to-last step is to review your entire scratchpad to synthesize a plan for the final outline.',
      //   'Finally, based *only* on the information you have gathered in your scratchpad, generate the complete, detailed outline and store it using the `store_outline` tool. You must only call `store_outline` ONCE at the very end.',
      // ],
    }),
  tools: {
    read_file: read_file_tool,
    // read_dir: read_dir_tool,
    // search_files: search_files_tool,
    // file_exists: file_exists_tool,
    update_scratchpad: scratchpad_tool,
    store_outline: tool({
      description: `Use this tool to store the generated outline.
		The outline should be a detailed hierarchical structure representing the sections and subsections of the repository documentation. In thory you can nest sections as deep as you want, but try to keep it to 4 levels deep maximum.

		## Example outline
		[
			{
				"title": "xxxx",
				"sections": [
					{
						"title": "yyyy",
						sections: [
							{
								"title": "vvvv",
								"sections": [...],
							}
						]
					},
					{
						"title": "gggg",
						"sections": [...],
					}
				]
			},
		]
			`,
      inputSchema: z.object({
        outline: OutlineSchema,
      }),
      // execute: ({ outline }, options) => {
      //   const context = toState<OutlineAgentContext>(options);
      //   // Store the outline in a file or database
      //   console.log('Generated Outline:\n', outline);
      //   context.outline = outline;
      //   return 'Outline stored successfully.';
      // },
    }),
  },
});

export const outlineCondensedAgent = agent<unknown, OutlineAgentContext>({
  name: 'Outline Condensed Agent',
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  // model: lmstudio('openai/gpt-oss-20b'),
  temperature: 0,
  prompt: instructions({
    purpose: [
      'To intelligently condense and optimize an existing outline by merging redundant sections, removing overly granular subdivisions, and creating a more streamlined, maintainable documentation structure.',
      'Your goal is to reduce complexity while preserving all essential information and maintaining logical hierarchy.',
    ],
    routine: [
      'Examine the current outline structure stored in the context. Use your scratchpad to track your analysis.',
      'Identify sections that are too granular (e.g., sections with only 1-2 subsections that could be merged with their parent).',
      'Look for redundant or overlapping sections that cover similar topics and can be consolidated.',
      'Note sections with excessive nesting depth (more than 3-4 levels) that could be flattened.',
      'Identify sections with very similar titles that could be merged (e.g., "API Overview" and "API Introduction").',
      'For each potential consolidation, add a note to your scratchpad explaining the rationale.',
      'Create a condensed version of the outline that:',
      '  - Merges related subsections into broader topics',
      '  - Reduces nesting depth where appropriate',
      '  - Eliminates redundancy while keeping all unique content areas',
      '  - Maintains a maximum depth of 3 levels unless absolutely necessary',
      '  - Ensures each section has substantial content to document',
      'Return the condensed outline as structured output.',
    ],
  }),
  output: OutlineSchema,
});

export async function generateOutline(state: OutlineAgentContext) {
  const messages: UIMessage[] = [
    user(
      'Walk through the repository and generate a detailed outline. Make sure to avoid looking into framework generated files and folders. when outline is complete, call the store_outline tool.',
    ),
  ];
  const max_iterations = 3;
  let current_iteration = 0;
  while (current_iteration < max_iterations) {
    console.log(`\n=== Outline Iteration ${current_iteration + 1} ===\n`);
    const result = execute(outlineAgent, messages, state);
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
    const outlineCall = calls.find((t) => t.toolName === 'store_outline');
    if (outlineCall) {
      console.log('\n=== Outline Generation Complete ===\n');
      state.outline = outlineCall.input.outline;
      break;
    }
    current_iteration++;
  }
  if (!state.outline.length) {
    throw new Error('Outline generation failed.');
  }
  return toOutput(
    generate(
      outlineCondensedAgent,
      `Condense and optimize the following outline:\n\n${buildToc(state.outline)}`,
      state,
    ),
  );
}

function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function buildToc(
  items: OutlineItem[],
  baseDepth = 1,
  prefix: string[] = [],
) {
  const lines: string[] = [];
  for (const it of items) {
    const path = [...prefix, it.title];
    const indent = '  '.repeat(Math.max(0, path.length - 1));
    const anchor = slugify(it.title);
    lines.push(`${indent}- [${it.title}](#${anchor})`);
    if (it.sections?.length) {
      lines.push(...buildToc(it.sections, baseDepth + 1, path));
    }
  }
  return lines;
}
