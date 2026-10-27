import { ContainerNotRunningError, Docker } from '@zukhruf/docker';
import { tool } from 'ai';
import { z } from 'zod';

const CONTAINER = 'toolos';

export const execute_os_command = tool({
  description:
    'Tool to execute Linux commands in an isolated Docker container with Node.js runtime. Use when you need OS operations like file management, package installation, network requests, or system commands. Returns the exitCode, stdout and stderr of the command; a non-zero exitCode means that the command failed.',
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
  execute: async (
    { command, working_directory, environment_vars },
    { abortSignal },
  ) => {
    await using docker = await Docker.connect({
      environment: process.env,
      signal: abortSignal,
    });
    const container = await docker.containers.find(CONTAINER, {
      signal: abortSignal,
    });
    if (!container) {
      throw new Error(
        `The container '${CONTAINER}' does not exist. Start it before you run a command.`,
      );
    }
    try {
      const { exitCode, stdout, stderr } = await container.exec(
        {
          Cmd: command,
          WorkingDir: working_directory,
          Env:
            environment_vars &&
            Object.entries(environment_vars).map(
              ([key, value]) => `${key}=${value}`,
            ),
        },
        { signal: abortSignal },
      );
      return { exitCode, stdout, stderr };
    } catch (error) {
      if (error instanceof ContainerNotRunningError) {
        throw new Error(
          `The container '${CONTAINER}' is not running (${error.state}). Start it before you run a command.`,
          { cause: error },
        );
      }
      throw error;
    }
  },
});
