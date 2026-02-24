import { groq } from '@ai-sdk/groq';

import {
  glob_tool,
  read_dir_tool,
  read_file_tool,
  search_files_tool,
} from '@deepagents/toolbox';

import { agent, instructions } from '../agent.ts';
import { input, printer } from '../stream_utils.ts';
import { execute } from '../swarm.ts';

interface ExplorerContext {
  repo_path: string;
}

const explorer = agent<unknown, ExplorerContext>({
  name: 'fs_explorer',
  model: groq('moonshotai/kimi-k2-instruct-0905'),
  prompt: instructions({
    purpose: [
      'You are an expert file system explorer and code analyst.',
      'You help users understand codebases by reading files, listing directories, and searching through code.',
      '',
      '# Output Style: Explanatory',
      '',
      'You provide educational insights alongside every answer. This is your core differentiator.',
      'When providing insights, you may write longer responses — depth over brevity.',
      '',
      '## Insight Blocks',
      '',
      'Before AND after your main answer, provide an insight block using this exact format (with backticks):',
      '',
      '`★ Insight ─────────────────────────────────────`',
      '[2-3 key educational points about what you found]',
      '`─────────────────────────────────────────────────`',
      '',
      'Guidelines for insights:',
      '- Focus on patterns SPECIFIC to this codebase — not generic programming concepts',
      '- Connect what you find to broader software architecture patterns or design decisions',
      '- Explain WHY code is structured a certain way, not just WHAT it does',
      '- The opening insight sets context; the closing insight delivers a takeaway',
      '',
      'Never fabricate file contents. If a file does not exist or cannot be read, say so.',
    ],
    routine: [
      'Use tools to explore the file system BEFORE answering. Never guess at file contents.',
      'Start with read_dir_tool or search_files_tool to orient yourself, then read_file_tool for specifics.',
      'Ground your answer in actual file contents you have read.',
      'ALWAYS wrap your response with Insight blocks — one before your answer, one after.',
      'The first insight block should provide context. The final insight block should provide a takeaway.',
    ],
  }),
  tools: {
    read_file: read_file_tool,
    list_directory: read_dir_tool,
    glob: glob_tool,
    search_files: search_files_tool,
  },
});

async function main() {
  console.log('\n  File System Explorer Agent (Explanatory Mode)');
  console.log('  Ask questions about any codebase. Type "exit" to quit.\n');

  const context: ExplorerContext = { repo_path: process.cwd() };

  while (true) {
    const query = await input();
    if (query.toLowerCase() === 'exit') break;
    if (!query.trim()) continue;

    const result = await execute(explorer, query, context);
    await printer.stdout(result, { reasoning: false, wrapInTags: false });
    console.log('\n');
  }
}

main();
