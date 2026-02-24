import { groq } from '@ai-sdk/groq';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import { snakeCase } from 'lodash-es';
import { writeFile } from 'node:fs/promises';

import {
  agent,
  execute,
  instructions,
  lmstudio,
  user,
} from '@deepagents/agent';
import { read_file_tool, search_content_tool } from '@deepagents/toolbox';

import { type Outline, buildToc } from './outline-agent.ts';

type SectionAgentContext = {
  repo_path: string;
  scratchpad: string;
  tree: string;
  toc: string[];
};

// Agent for writing leaf sections
const sectionWriterAgent = agent<SectionAgentContext>({
  name: 'Section Writer',
  model: wrapLanguageModel({
    // model: groq('moonshotai/kimi-k2-instruct-0905'),
    model: lmstudio('openai/gpt-oss-20b'),
    middleware: defaultSettingsMiddleware({
      settings: { temperature: 0.5 },
    }),
  }),
  tools: {
    read_file: read_file_tool,
    search_content: search_content_tool,
  },
  prompt: '',
});

// Agent for writing parent TOC pages
const tocPageAgent = agent<SectionAgentContext>({
  name: 'TOC Page Writer',
  model: wrapLanguageModel({
    model: groq('moonshotai/kimi-k2-instruct-0905'),
    middleware: defaultSettingsMiddleware({
      settings: { temperature: 0.1 },
    }),
  }),
  prompt: instructions({
    purpose: [
      'You create table-of-contents style pages for wiki parent sections.',
      'Your pages introduce the parent topic and provide an organized overview of child sections.',
    ],
    routine: [
      'Write a clear, engaging introduction to the parent section topic.',
      'Provide context about what readers will learn in the child sections.',
      'Create a structured overview that explains how child sections relate to each other.',
      'Your content should help readers understand the big picture before diving into specifics.',
      'Do NOT duplicate detailed content - that belongs in the child pages.',
    ],
  }),
});

type WikiResult = {
  files: Record<string, string>; // section title -> file path
  index: string; // main index content
};

/**
 * Build file path for a section based on its hierarchical path
 * Example: ['Project Overview', 'Architecture'] -> 'docs/project_overview_architecture.md'
 */
function buildFilePath(pathSegments: string[]): string {
  return `${snakeCase(pathSegments.join('_'))}.md`;
}

/**
 * Write content for a leaf section using the section writer agent
 */
async function writeSection(
  item: Outline[number],
  pathSegments: string[],
  state: SectionAgentContext,
): Promise<string> {
  console.log(`Writing section: ${pathSegments.join(' > ')}`);

  const result = await execute(
    sectionWriterAgent,
    [
      user(
        `You are writing the section: ${item.title}

Full path: ${pathSegments.join(' > ')}

The complete wiki outline is:
<WikiOutline>
${state.toc.join('\n')}
</WikiOutline>

The repository structure is:
<RepositoryTree>
${state.tree}
</RepositoryTree>

Your task:
1. Use the provided tools to inspect relevant files in the repository
2. Write clear, comprehensive, and accurate markdown content for this section
3. Include code examples where appropriate
4. Ensure the content is self-contained and valuable
5. Focus specifically on the topic: ${item.title}

Write the section content now.
`,
      ),
    ],
    state,
  );

  return result.text;
}

/**
 * Write a TOC-style page for a parent section
 */
async function writeTocPage(
  item: Outline[number],
  pathSegments: string[],
  childFiles: Array<{ title: string; path: string }>,
  state: SectionAgentContext,
): Promise<string> {
  console.log(`Writing TOC page: ${pathSegments.join(' > ')}`);

  const childSummaries = childFiles
    .map((child, index) => `${index + 1}. **${child.title}**`)
    .join('\n');

  const childLinks = childFiles
    .map((child) => `- [${child.title}](${child.path})`)
    .join('\n');

  const result = await execute(
    tocPageAgent,
    [
      user(
        `You are creating a table-of-contents page for the section: ${item.title}

Full path: ${pathSegments.join(' > ')}

This parent section has the following child sections:
${childSummaries}

The complete wiki outline is:
<WikiOutline>
${state.toc.join('\n')}
</WikiOutline>

The repository structure is:
<RepositoryTree>
${state.tree}
</RepositoryTree>

Your task:
1. Write a clear introduction to the "${item.title}" topic
2. Explain what readers will learn from the child sections below
3. Provide context about how these child sections relate to each other
4. Keep it concise - this is a navigation page, not the full content

After your introduction, you MUST include this exact navigation section:

## Sections

${childLinks}

Write the TOC page content now (introduction followed by the navigation section above).
`,
      ),
    ],
    state,
  );

  return result.text;
}

/**
 * Recursively process outline items and generate markdown files
 */
async function processOutlineItem(
  item: Outline[number],
  pathSegments: string[],
  state: SectionAgentContext,
  files: Record<string, string>,
): Promise<void> {
  const currentPath = [...pathSegments, item.title];
  const filePath = buildFilePath(currentPath);

  if (!item.sections || item.sections.length === 0) {
    // Leaf node - write comprehensive content
    const content = await writeSection(item, currentPath, state);
    await writeFile(filePath, content, 'utf-8');
    files[item.title] = filePath;
    console.log(`✓ Created: ${filePath}`);
  } else {
    // Parent node - process children first, then create TOC page
    const childFiles: Array<{ title: string; path: string }> = [];

    for (const child of item.sections) {
      await processOutlineItem(child, currentPath, state, files);
      const childPath = buildFilePath([...currentPath, child.title]);
      childFiles.push({ title: child.title, path: childPath });
    }

    // Create TOC page for parent
    const content = await writeTocPage(item, currentPath, childFiles, state);
    await writeFile(filePath, content, 'utf-8');
    files[item.title] = filePath;
    console.log(`✓ Created TOC: ${filePath}`);
  }
}

/**
 * Generate a complete multi-page wiki from an outline
 *
 * This function creates separate markdown files for each section:
 * - Leaf sections get comprehensive content written by agents
 * - Parent sections get TOC-style pages with introductions and links to children
 * - All files use flat naming with full hierarchical path
 */
export async function completeWiki(state: {
  repo_path: string;
  outline: Outline;
  tree: string;
}): Promise<WikiResult> {
  const toc = buildToc(state.outline);
  const files: Record<string, string> = {};

  const agentContext: SectionAgentContext = {
    repo_path: state.repo_path,
    scratchpad: '## Scratchpad\n\n',
    tree: state.tree,
    toc,
  };

  console.log('Starting multi-page wiki generation...');

  // Process each top-level item
  for (const item of state.outline) {
    await processOutlineItem(item, [], agentContext, files);
  }

  // Create main index page
  const indexLinks = state.outline
    .map((item) => {
      const filePath = buildFilePath([item.title]);
      return `- [${item.title}](${filePath})`;
    })
    .join('\n');

  const index = `# Wiki Index

Welcome to the documentation. This wiki is organized into the following sections:

${indexLinks}
`;

  console.log(`✓ Complete! Generated ${Object.keys(files).length} pages`);

  return { files, index };
}
