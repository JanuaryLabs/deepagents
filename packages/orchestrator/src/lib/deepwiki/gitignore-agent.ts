import { groq } from '@ai-sdk/groq';
import { tool } from 'ai';
import z from 'zod';

import {
	agent,
	instructions,
	toState
} from '@deepagents/agent';

import { read_dir_tool, read_file_tool } from './tools.ts';

export const ignoreAgent = agent<{ repo_path: string }>({
  name: 'Ignore Agent',
  model: groq('openai/gpt-oss-20b'),
  prompt: instructions({
    purpose:
      'To generate a comprehensive .gitignore file tailored to the specific technologies and frameworks used in a given code repository, ensuring that unnecessary or sensitive files are excluded from version control.',
    routine: [
      'Analyze the repository structure and identify key files and directories that should be ignored based on common development practices.',
      'Identify the primary programming languages, frameworks, and tools used in the repository by looking for specific configuration files (e.g., package.json for Node.js, requirements.txt for Python, pom.xml for Java).',
      "Based on the identified technologies, include standard ignore patterns from established templates (e.g., GitHub's collection of .gitignore templates) to cover common build artifacts, dependencies, and environment-specific files.",
      'Consider any custom or unique files in the repository that may need to be ignored, such as local configuration files, logs, or temporary files generated during development.',
      'Compile a comprehensive .gitignore file that includes all relevant patterns, ensuring it is well-organized and easy to understand.',
      'Present the final .gitignore content, ready to be added to the repository to optimize version control practices.',
    ],
  }),
  tools: {
    read_dir: read_dir_tool,
    read_file: read_file_tool,
    store_gitignore: tool({
      description: 'Use this tool to store the generated .gitignore content.',
      inputSchema: z.object({
        content: z
          .string()
          .min(1)
          .describe('The content of the .gitignore file.'),
      }),
      execute: async ({ content }, options) => {
        const context = toState<{ repo_path: string }>(options);
        console.log('Generated .gitignore content:\n', content);
        // await fs.promises.writeFile(join(context.repo_path, '.gitignore'), content);
        return 'Successfully wrote .gitignore file.';
      },
    }),
  },
});
