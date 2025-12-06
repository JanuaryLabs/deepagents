import { groq } from '@ai-sdk/groq';
import { defaultSettingsMiddleware, tool, wrapLanguageModel } from 'ai';
import dedent from 'dedent';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import z from 'zod';

import { agent, generate, stream, user } from '@deepagents/agent';

const defaultPrompt = dedent`

<SystemContext>
	You are a code execution agent that writes and runs TypeScript code to accomplish user requests.

	<Identity>
	Your role is to translate user instructions into executable TypeScript code that produces results.
	You excel at:
	- Breaking down requests into simple, executable code
	- Choosing appropriate Node.js APIs for the task
	- Writing clear, correct TypeScript with proper imports
	- Analyzing errors and adjusting approach when needed
	</Identity>

	<ExecutionEnvironment>
	Runtime: Node.js with ES module support
	Execution Model: Files are dynamically imported after creation
	Project Root: Accessible via process.cwd()
	</ExecutionEnvironment>

	<Tools>
	write_content(fileName: string, content: string)
	- Creates or overwrites a .ts file in .evolving/ directory
	- Only .ts extensions permitted
	- Parent directories created automatically

	run_code(fileName: string)
	- Executes a TypeScript file via dynamic import()
	- File must exist before execution (write first, then run)
	- Returns module exports object
	</Tools>

	<Methodology>
	Phase 1: Analysis
	- Understand what data or result the user needs
	- Identify which Node.js APIs are appropriate (fs, path, etc.)

	Phase 2: Implementation
	- Write TypeScript code using appropriate imports
	- Use process.cwd() for project root references
	- Include console.log statements for output visibility
	- Export data if needed for further processing

	Phase 3: Execution
	- Run the code file
	- Observe results and determine if goal is achieved
	</Methodology>

	<Principles>
	Code Approach:
	✓ Start with synchronous operations (readdirSync, readFileSync)
	✓ Use ES module imports (import { x } from 'module')
	✓ Reference project root with process.cwd()
	✓ Write self-contained code with clear variable names
	✗ Avoid async callbacks when synchronous versions exist
	✗ Avoid complex path manipulations when simple ones suffice
	✗ Avoid mixing CommonJS (require) with ES modules (import)

	Error Handling:
	✓ Read error messages carefully to understand root cause
	✓ Check if the issue is environmental, syntactic, or logical
	✓ Adjust approach based on specific error, not generic retries
	✗ Avoid repeating the same approach if it failed
	✗ Avoid trying multiple variations without understanding why previous attempts failed

	Iteration Management:
	✓ Attempt a straightforward solution first
	✓ If first attempt fails, analyze the error and make ONE targeted fix
	✓ If second attempt fails, reconsider the approach entirely
	✗ Stop after 3 failed attempts and report the issue
	✗ Avoid trial-and-error loops without clear reasoning
	</Principles>

	<CriticalInstructions>
	- Maximum 3 retry attempts per task before reporting the issue
	- Each file write should be purposeful, not exploratory
	- run_code must only be called on files that were written via write_content
	- Follow the user's instructions precisely and deliver the requested results
	</CriticalInstructions>

</SystemContext>

`;

const PROMPT_FILE_PATH = join(
  process.cwd(),
  '.evolving',
  'executor-prompt.txt',
);

const prompt =
  (await readFile(PROMPT_FILE_PATH, 'utf-8').catch(() => defaultPrompt)) ||
  defaultPrompt;

async function savePrompt(promptText: string): Promise<void> {
  await mkdir(dirname(PROMPT_FILE_PATH), { recursive: true });
  await writeFile(PROMPT_FILE_PATH, promptText, 'utf-8');
  console.log('Saved revised prompt to file');
}

const executorTools = {
  write_content: tool({
    name: 'write_content',
    description: 'Writes content based on given instructions.',
    inputSchema: z.object({
      fileName: z.string().describe('The name of the file to write to.'),
      content: z.string().describe('The content to be written.'),
    }),
    execute: async ({ fileName, content }) => {
      if (extname(fileName) !== '.ts') {
        return 'Error: Can only write .ts files.';
      }
      await mkdir(dirname(join(process.cwd(), '.evolving', fileName)), {
        recursive: true,
      });
      await writeFile(
        join(process.cwd(), '.evolving', fileName),
        content,
        'utf-8',
      );
      return `File written: ${fileName}`;
    },
  }),
  run_code: tool({
    name: 'run_code',
    description: 'Executes provided code snippets and returns the output.',
    inputSchema: z.object({
      fileName: z
        .string()
        .describe('The name of the file containing the code to run.'),
    }),
    execute: async ({ fileName }) => {
      return await import(join(process.cwd(), '.evolving', fileName));
    },
  }),
};

const adaptingAgent = agent({
  model: groq('openai/gpt-oss-20b'),
  name: 'adapting_agent',
  prompt: dedent`
		You are an adapting agent that update other agents system prompt and behavior based on execution results.
		Your job is to analyze execution results and refine the executor agent's prompt to improve future performance.
		Consider what changes to the system context, identity, methodology, principles, or critical instructions could help the executor succeed.
		Provide a revised prompt that addresses any shortcomings revealed by the execution results.
`,
  output: z.object({
    revisedPrompt: z
      .string()
      .describe('The revised system prompt for the executor.'),
  }),
});

const USER_TASK = `Using typescript compiler, count how many times the agent function have been invoked. use tsconfig.base.json as project configuration.`;
const MAX_REFINEMENTS = 3;

// Main adaptation loop
async function runAdaptationCycle() {
  let currentPrompt = prompt;
  for (let iteration = 1; iteration <= MAX_REFINEMENTS; iteration++) {
    console.log(
      `\n========== Iteration ${iteration}/${MAX_REFINEMENTS} ==========`,
    );

    // Create executor with current prompt
    const executor = agent({
      name: 'executor_agent',
      model: wrapLanguageModel({
        model: groq('openai/gpt-oss-120b'),
        middleware: defaultSettingsMiddleware({
          settings: { temperature: 0 },
        }),
      }),
      prompt: currentPrompt,
      tools: executorTools,
    });

    // Run executor
    const result$ = stream(executor, [user(USER_TASK)], {});
    const messages = await Array.fromAsync(result$.toUIMessageStream());
    await result$.consumeStream();

    const reasoning = messages
      .filter((it) => it.type === 'reasoning-delta')
      .map((it) => it.delta)
      .join('');

    const text = messages
      .filter((it) => it.type === 'text-delta')
      .map((it) => it.delta)
      .join('');

    console.log('Final Result Text:', text);

    // Run adapting agent
    const {
      experimental_output: { revisedPrompt },
    } = await generate(
      adaptingAgent,
      [
        user(
          `
					<ExecutionResults>
						${text}
					</ExecutionResults>

					<AgentReasoning>
						${reasoning}
					</AgentReasoning>

					<AgentPrompt>
						${currentPrompt}
					</AgentPrompt>
				`,
        ),
      ],
      {},
    );

    // Save and use revised prompt for next iteration
    await savePrompt(revisedPrompt);
    currentPrompt = revisedPrompt;
  }

  console.log('\n========== Adaptation Complete ==========');
}

runAdaptationCycle();
