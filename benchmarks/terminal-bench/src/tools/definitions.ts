import { tool } from 'ai';
import { z } from 'zod';

import type { Bridge } from '../bridge.ts';

export function createTools(bridge: Bridge) {
  const commandHistory: string[] = [];
  let completionAttempts = 0;

  const run_commands = tool({
    description:
      'Run shell commands in the terminal environment. Analyze the current state, plan your next action, then provide commands to run.',
    inputSchema: z.object({
      analysis: z
        .string()
        .describe('Analysis of current state and observations.'),
      plan: z.string().describe('Plan for what to do next and why.'),
      commands: z
        .array(z.string())
        .describe('Shell commands to run, in order.'),
    }),
    execute: async ({ commands }) => {
      const repeated = commands.filter(
        (cmd) => commandHistory.filter((h) => h === cmd).length >= 2,
      );

      if (repeated.length > 0) {
        commandHistory.push(...commands);
        return (
          `WARNING: You have repeated these commands 3+ times: ${repeated.join(', ')}. ` +
          'Step back and try a fundamentally different approach. ' +
          'Consider: different tools, different file paths, different algorithms, or reading documentation first.'
        );
      }

      commandHistory.push(...commands);

      const results: string[] = [];
      for (const cmd of commands) {
        const { stdout, stderr, returnCode } = await bridge.runCommand(cmd);
        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += `\nSTDERR: ${stderr}`;
        if (returnCode !== 0) output += `\nExit code: ${returnCode}`;
        results.push(`$ ${cmd}\n${output.trim()}`);
      }
      return results.join('\n\n');
    },
  });

  const task_complete = tool({
    description:
      'Signal that the task is complete. Only call after verifying all requirements are met.',
    inputSchema: z.object({
      summary: z.string().describe('Summary of what was accomplished.'),
    }),
    execute: async ({ summary }) => {
      completionAttempts++;
      if (completionAttempts === 1) {
        return (
          'VERIFICATION REQUIRED: Before completing, you must verify your solution. ' +
          'Re-read the original task instruction carefully. List every requirement. ' +
          'For each requirement, run a verification command to confirm it is satisfied. ' +
          'Only call task_complete again after ALL requirements are verified to work correctly.'
        );
      }
      return `Task complete: ${summary}`;
    },
  });

  return { run_commands, task_complete };
}
