import { type UIMessage } from 'ai';
import { writeFile } from 'node:fs/promises';

import {
  agent,
  execute,
  instructions,
  lmstudio,
  user,
} from '@deepagents/agent';
import { scratchpad_tool } from '@deepagents/toolbox';

import { buildToc } from './outline-agent.ts';
import { search_content_tool } from './tools.ts';

type OutlineItem = { title: string; sections?: OutlineItem[] };

type SectionAgentContext = {
  repo_path: string;
  section_path: string[];
  scratchpad: string;
};

const sectionWriter = agent<SectionAgentContext>({
  name: 'wiki-section-writer',
  // model: lmstudio('openai/gpt-oss-20b'),
  model: lmstudio('qwen/qwen3-4b-2507'),
  temperature: 0,
  prompt: instructions({
    purpose: [
      'You write comprehensive, accurate, and actionable documentation sections for a repository wiki.',
      'You can inspect files and directory structure using provided tools to ground your writing in the actual codebase.',
    ],
    routine: [
      'Use the scratchpad to note findings from reading files or directories; keep it concise and relevant.',
      'Clarify scope: write ONLY for the current section path you are working on; do not expand into subsections (those are handled separately).',
      'When pasting code, include only short, illustrative snippets—do not dump large files.',
      'Avoid references to unknown frameworks or generated folders; ground claims in actual repo contents when possible.',
      'Make use of the `search_content` tool to find relevant information in the codebase. this tool can search the entire repository for keywords or topics. use it to find code examples, explanations, or relevant files.',
      'Return ONLY the final markdown for this section.',
    ],
  }),
  tools: {
    // read_file: read_file_tool,
    // read_dir: read_dir_tool,
    // search_files: search_files_tool,
    search_content: search_content_tool,
    update_scratchpad: scratchpad_tool,
  },
});

function headingFor(level: number, title: string) {
  const capped = Math.min(Math.max(level, 1), 6);
  return `${'#'.repeat(capped)} ${title}`;
}

async function renderSection(
  outline: OutlineItem,
  path: string[],
  ctx: { repo_path: string },
) {
  const messages: UIMessage[] = [
    user(
      [
        `You are part of an AI team writing a project wiki based on a structured outline.`,
        `You are writing the section: ${path.join(' > ')}`,
        'Provide the final markdown for this section (no JSON, no commentary).',
      ].join('\n'),
    ),
  ];

  return execute(sectionWriter, messages, {
    repo_path: ctx.repo_path,
    section_path: path,
    scratchpad: '## Scratchpad\n\n',
  }).text;
}

async function renderOutline(
  items: OutlineItem[],
  ctx: { repo_path: string },
  depth = 1,
  path: string[] = [],
): Promise<string> {
  let out = '';
  for (const item of items) {
    const currentPath = [...path, item.title];
    out += `\n\n${headingFor(depth, item.title)}\n\n`;
    const content = await renderSection(item, currentPath, ctx);
    await writeFile(`./${currentPath.join('-')}.md`, content, 'utf-8');
    if (content) {
      out += `${content}\n`;
    }
    if (item.sections?.length) {
      out += await renderOutline(item.sections, ctx, depth + 1, currentPath);
    }
  }
  return out;
}

export async function generateWiki(
  outline: OutlineItem[],
  options: { repo_path: string },
) {
  const header = [
    '# Project Wiki',
    '',
    '## Table of Contents',
    ...buildToc(outline),
  ].join('\n');

  const body = await renderOutline(
    outline,
    { repo_path: options.repo_path },
    1,
  );
  return `${header}\n\n${body}\n`;
}
