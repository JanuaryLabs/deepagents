import { groq } from '@ai-sdk/groq';
import { defaultSettingsMiddleware, tool, wrapLanguageModel } from 'ai';
import { snakeCase } from 'lodash-es';
import { readFile, writeFile } from 'node:fs/promises';
import z from 'zod';

import {
  agent,
  execute,
  instructions,
  lmstudio,
  printer,
  toState,
  user,
} from '@deepagents/agent';
import { scratchpad_tool } from '@deepagents/toolbox';

import { fold } from '../graph.ts';
import { type Outline, buildToc } from './outline-agent.ts';
import { read_file_tool, search_content_tool } from './tools.ts';

type SectionAgentContext = {
  repo_path: string;
  scratchpad: string;
  tree: string;
  toc: string[];
  section_path: Record<string, string>;
};

const writer = agent<SectionAgentContext>({
  name: 'Wiki Writer',
  model: lmstudio('qwen/qwen3-8b'),
  // model: groq('openai/gpt-oss-120b'),
  // model: groq('openai/gpt-oss-20b'),
  prompt: instructions({
    purpose: [
      'You write comprehensive, accurate, and actionable documentation sections for a repository wiki.',
      'You can inspect files and directory structure using provided tools to ground your writing in the actual codebase.',
    ],
    routine: [
      'Use the scratchpad to note findings from reading files or directories; keep it concise and relevant.',
      'Clarify scope: write ONLY for the current section path you are working on; do not expand into subsections (those are handled separately).',
      'Avoid references to unknown frameworks or generated folders; ground claims in actual repo contents when possible.',
      'Make use of the `search_content` tool to find relevant information in the codebase. this tool can search the entire repository for keywords or topics. use it to find code examples, explanations, or relevant files.',
      'When you return a section via write_section, set sectionTitle to the FULL hierarchical path of the section using ">" as a separator (e.g., "Parent > Child > Subchild").',
    ],
  }),
  tools: {
    read_file: read_file_tool,
    // read_dir: read_dir_tool,
    // search_files: search_files_tool,
    write_section: tool({
      name: 'write_section',
      description:
        'Use this tool to return the final markdown content for the current section. You MUST use this tool to return your final output.',
      inputSchema: z.object({
        sectionTitle: z
          .string()
          .describe(
            'The title of the section being written. Prefer the FULL hierarchical path like "Parent > Child" to ensure uniqueness.',
          ),
        sectionContent: z
          .string()
          .describe(
            'The markdown content for the section excluding section heading.',
          ),
      }),
      execute: async ({ sectionTitle, sectionContent }, options) => {
        const context = toState<SectionAgentContext>(options);
        //         const text = await execute(
        //           sectionWriter,
        //           [
        //             user(`You are writing the section at path: ${path}. The section should comprehensively cover this topic based on the repository contents.

        // You have identified the following related files that may contain relevant information for this section:
        // ${related_files.map((f) => `- ${f}`).join('\n')}

        // Use the tools to inspect these files and gather information. Summarize key points, code examples, and explanations that will help create a thorough and accurate documentation section.

        // Remember to keep your writing clear, concise, and focused on the current section topic. Do not include information about other sections or subsections.

        //           ],
        //           {},
        //         ).text;
        const p = `./docs/section_${snakeCase(sectionTitle)}.md`;
        await writeFile(p, sectionContent, 'utf-8');
        context.section_path[sectionTitle] = p;
        return `Section "${sectionTitle}" written to file.`;
        // return text;
      },
    }),
    search_content: search_content_tool,
    update_scratchpad: scratchpad_tool,
  },
});

function headingFor(level: number, title: string) {
  const capped = Math.min(Math.max(level, 1), 6);
  return `${'#'.repeat(capped)} ${title}`;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return undefined;
  }
}

async function aggregateSections(
  items: Outline,
  depth: number,
  state: SectionAgentContext,
  path: string[] = [],
): Promise<string> {
  let out = '';
  for (const item of items) {
    const currentPath = [...path, item.title];
    const pathKey = currentPath.join(' > ');
    const directKey = item.title;

    // Prefer mapped file based on full path, fall back to title, then inferred filename(s)
    const mappedPath =
      state.section_path[pathKey] || state.section_path[directKey];
    const inferredCandidates = [
      `./section_${snakeCase(pathKey)}.md`,
      `./section_${snakeCase(directKey)}.md`,
    ];

    let content: string | undefined;
    if (mappedPath) {
      content = await readIfExists(mappedPath);
    }
    if (!content) {
      for (const p of inferredCandidates) {
        content = await readIfExists(p);
        if (content) break;
      }
    }

    out += `\n\n${headingFor(depth, item.title)}\n\n`;
    if (content) out += `${content}\n`;

    if (item.sections?.length) {
      out += await aggregateSections(
        item.sections,
        depth + 1,
        state,
        currentPath,
      );
    }
  }
  return out;
}

export async function generateWiki(options: {
  repo_path: string;
  outline: Outline;
  tree: string;
}) {
  const toc = buildToc(options.outline);
  const state: SectionAgentContext = {
    repo_path: options.repo_path,
    scratchpad: '## Scratchpad\n\n',
    tree: options.tree,
    toc: toc,
    section_path: {},
  };

  //   await execute(
  //     writer,
  //     [
  //       user(`You are tasked with writing a comprehensive wiki for a code repository. The wiki will be structured according to the provided outline, which details the sections and subsections to be covered.

  // <RepositoryTree>
  // ${options.tree}
  // </RepositoryTree>

  // <WikiOutline>
  // ${toc}
  // </WikiOutline>

  // Your job is to write each section of the wiki based on this outline. For each section, you should:

  // 1. Understand the section title and its place in the overall structure.
  // 2. Use the provided tools to inspect relevant files and directories in the repository to gather information for that section.
  // 3. Write clear, concise, and informative markdown content for the section, including code examples where appropriate.
  // 4. Ensure that each section is self-contained and provides value to someone reading the wiki.

  // Begin by writing the top-level sections of the outline. For each section, if there are subsections, you will handle those separately after completing the parent section.

  // Important: When calling write_section, set sectionTitle to the FULL hierarchical path (e.g., "Parent > Child > Subchild").

  //     ],
  //     state,
  //   ).text;

  //   const header = ['# Project Wiki', '', '## Table of Contents', ...toc].join(
  //     '\n',
  //   );

  //   const body = await aggregateSections(options.outline, 1, state);
  //   return `${header}\n\n${body}\n`;
  return '';
}

type IsolatedSectionAgentContext = {
  repo_path: string;
  scratchpad: string;
  tree: string;
  toc: string[];
};
const sectionWriterAgent = agent<IsolatedSectionAgentContext>({
  name: 'Section Writer',
  // model: lmstudio('qwen/qwen3-8b'),
  model: groq('openai/gpt-oss-20b'),
  // temperature: 0.3,
  tools: {
    read_file: read_file_tool,
    search_content: search_content_tool,
  },
  prompt: '',
});

type StitchAgentContext = {
  repo_path: string;
  scratchpad: string;
  tree: string;
  toc: string[];
};
const stitchAgent = agent<StitchAgentContext>({
  name: 'Stitch Agent',
  model: wrapLanguageModel({
    model: groq('moonshotai/kimi-k2-instruct-0905'),
    middleware: defaultSettingsMiddleware({
      settings: { temperature: 0.1 },
    }),
  }),
  prompt: instructions({
    purpose: [
      'You synthesize and stitch together child subsections into a cohesive parent section for a wiki.',
      'Your role is to create an introduction and transitions that bind child sections together while maintaining clarity and flow.',
    ],
    routine: [
      'Review all child section contents provided to understand their focus and relationships.',
      'Create a cohesive parent section that introduces the topic and smoothly connects to the child sections.',
      'Add transitions and context that help readers understand how child sections relate to each other.',
      'Do NOT duplicate content from child sections; reference and introduce them instead.',
      'Keep your writing clear, concise, and focused on synthesis rather than repetition.',
    ],
  }),
});

function write(state: IsolatedSectionAgentContext, item: Outline[number]) {
  console.log(buildToc([item]));
  return execute(
    sectionWriterAgent,
    [
      user(
        `
        You are part of a team writing a comprehensive wiki for a code repository. Your specific task is to write the following section of the wiki:

<SectionTitle>
  ${item.title}
</SectionTitle>
<ActiveSectionWiki>
  ${buildToc([item])}
</ActiveSectionWiki>

The complete wiki outline is as follows:
<WikiOutline>
${state.toc}
</WikiOutline>

The repository structure is as follows:

<RepositoryTree>
${state.tree}
</RepositoryTree>

You should:

1. Understand the section title and its place in the overall structure.
2. Use the provided tools to inspect relevant files and directories in the repository to gather information for that section.
3. Write clear, concise, and informative markdown content for the section, including code examples where appropriate.
4. Ensure that the section is self-contained and provides value to someone reading the wiki.

Remember to keep your writing clear, concise, and focused on the current section topic. Do not include information about other sections or subsections.
`,
      ),
    ],
    state,
  );
}

function stitch(
  state: StitchAgentContext,
  item: Outline[number],
  childSections: Array<{ title: string; content: string }>,
) {
  const childSectionsList = childSections
    .map(
      (child) => `
### ${child.title}
${child.content}
`,
    )
    .join('\n');

  return execute(
    stitchAgent,
    [
      user(
        `
        You are stitching together child subsections into a cohesive parent section for a wiki. Your task is to create an introduction and transitions that bind the following child sections together.

<ParentSectionTitle>
  ${item.title}
</ParentSectionTitle>

<ChildSections>
${childSectionsList}
</ChildSections>

The complete wiki outline is as follows:
<WikiOutline>
${state.toc}
</WikiOutline>

The repository structure is as follows:

<RepositoryTree>
${state.tree}
</RepositoryTree>

Your task is to:

1. Create an introduction to the parent section that sets the context for the child sections.
2. Add smooth transitions between child sections that explain their relationships.
3. Synthesize the content into a cohesive narrative rather than just concatenating the children.
4. Do NOT duplicate the full content of child sections - assume readers will see them in context.
5. Focus on creating connections and providing high-level overview.

`,
      ),
    ],
    state,
  );
}

function assembleDocument(
  items: Outline,
  local: Record<string, string>,
  depth: number,
): string {
  let output = '';

  for (const item of items) {
    const content = local[item.title];

    // Add heading for this section
    output += `${headingFor(depth, item.title)}\n\n`;

    // Add the content - if this is a parent section,
    // the stitched content already includes all children inline
    if (content) {
      output += `${content}\n\n`;
    }
  }

  return output;
}

export async function singlePageWiki(state: {
  repo_path: string;
  outline: Outline;
  tree: string;
}) {
  const root = state.outline[0];
  const local: Record<string, string> = {};
  const store = {
    async set(key: string, value: string) {
      await writeFile(`./docs/section_${snakeCase(key)}.md`, value, 'utf-8');
      local[key] = value;
    },
  };
  await fold(
    root,
    { title: root.title },
    async (item) => {
      if (!item.sections || item.sections.length === 0) {
        const result = write(
          {
            repo_path: state.repo_path,
            tree: state.tree,
            scratchpad: '## Scratchpad\n\n',
            toc: buildToc(state.outline),
          },
          item,
        );
        // await printer.stdout(result);
        return result.text;
      } else {
        // Stitch the parent section from child sections
        const stitchResult = stitch(
          {
            repo_path: state.repo_path,
            tree: state.tree,
            scratchpad: '## Scratchpad\n\n',
            toc: buildToc(state.outline),
          },
          item,
          Object.entries(local)
            .filter(([k]) => item.sections!.some((key) => key.title === k))
            .map(([title, content]) => ({ title, content })),
        );
        console.log('=== STITCH RESULT ===');
        await printer.stdout(stitchResult);
        return stitchResult.text;
      }
    },
    store,
  );

  // Assemble the final document from all processed sections
  return assembleDocument(state.outline, local, 1);
}
