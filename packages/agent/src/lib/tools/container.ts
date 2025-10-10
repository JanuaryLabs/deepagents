import { tool } from 'ai';
import spawn from 'nano-spawn';
import { z } from 'zod';

export const execute_os_command = tool({
  description:
    'Tool to execute Linux commands in an isolated Docker container with Node.js runtime. Use when you need OS operations like file management, package installation, network requests, or system commands.',
  inputSchema: z.object({
    command: z
      .array(z.string().min(1, 'Command parts cannot be empty'))
      .min(1, 'At least one command part is required')
      .max(20, 'Command cannot exceed 20 parts for security')
      .describe(
        'Command and arguments as array. Examples: ["ls", "-la"], ["npm", "install", "lodash"], ["curl", "-s", "https://api.github.com"], ["node", "--version"]',
      ),
    working_directory: z
      .string()
      .regex(/^\/[a-zA-Z0-9_/.,-]*$/, 'Must be a valid absolute Linux path')
      .optional()
      .describe(
        'Absolute working directory path. Examples: "/tmp", "/workspace", "/app". Defaults to container root.',
      ),
    environment_vars: z
      .record(
        z.string().min(1, 'Environment variable values cannot be empty'),
        z.string(),
      )
      .optional()
      .describe(
        'Environment variables as key-value pairs. Examples: {"NODE_ENV": "development", "API_KEY": "secret123"}',
      ),
  }),
  execute: ({ command, working_directory, environment_vars }) => {
    return exec(command, working_directory, environment_vars);
  },
});

function exec(
  command: string[],
  working_directory?: string,
  environment_vars?: Record<string, string>,
) {
  const args = ['exec', '-i'];

  if (working_directory) {
    args.push('-w', working_directory);
  }

  if (environment_vars) {
    Object.entries(environment_vars).forEach(([key, value]) => {
      args.push('-e', `${key}=${value}`);
    });
  }

  args.push('toolos', ...command);

  return spawn('docker', args, {
    stdio: 'pipe',
  });
}
