import { tool } from 'ai';
import {
  type CommandResult,
  type CreateBashToolOptions,
  type Sandbox,
  createBashTool as externalCreateBashTool,
} from 'bash-tool';
import { AsyncLocalStorage } from 'node:async_hooks';
import z from 'zod';

import { BashException } from './bash-exception.ts';
import { readBashMeta, runWithBashMeta } from './bash-meta.ts';
import type {
  AgentSandbox,
  SkillUploadInput,
  WrappedBashTool,
} from './types.ts';
import { uploadSkills } from './upload-skills.ts';

const REASONING_INSTRUCTION =
  'Every bash tool call must include a brief non-empty "reasoning" input explaining why the command is needed.';

const bashExecAbortSignal = new AsyncLocalStorage<AbortSignal | undefined>();

interface AbortableJustBash {
  exec(
    command: string,
    options?: { signal?: AbortSignal },
  ): Promise<CommandResult>;
  fs: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
  };
}

function isAbortableJustBash(value: unknown): value is AbortableJustBash {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { exec?: unknown }).exec === 'function' &&
    typeof (value as { fs?: { readFile?: unknown; writeFile?: unknown } }).fs
      ?.readFile === 'function' &&
    typeof (value as { fs?: { readFile?: unknown; writeFile?: unknown } }).fs
      ?.writeFile === 'function'
  );
}

function wrapAbortableJustBash(bash: AbortableJustBash): Sandbox {
  return {
    async executeCommand(command) {
      const signal = bashExecAbortSignal.getStore();
      const result = await bash.exec(command, signal ? { signal } : undefined);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },

    async readFile(path) {
      return bash.fs.readFile(path);
    },

    async writeFiles(files) {
      for (const file of files) {
        await bash.fs.writeFile(
          file.path,
          typeof file.content === 'string'
            ? file.content
            : Buffer.from(file.content).toString('utf-8'),
        );
      }
    },
  };
}

export interface CreateBashToolWithSkillsOptions extends CreateBashToolOptions {
  /**
   * Skill directories to upload into the sandbox at startup. Each entry's
   * contents are copied to `sandbox` (files + subdirectories) and each
   * subdirectory containing a SKILL.md is parsed into `sandbox.skills`.
   */
  skills?: SkillUploadInput[];
}

/**
 * Wrapper around the external `bash-tool` factory. Adds:
 *   - Always-on `reasoning` input on the bash tool schema.
 *   - Sandbox-boundary catch for `BashException` (subclasses define their own
 *     `format()` → CommandResult). Applies to `toolkit.sandbox.executeCommand`
 *     and therefore to the tool-execute path as well (upstream calls that
 *     exact method).
 *   - Generic meta channel (`useBashMeta()`): handlers can call
 *     `setHidden(patch)` to attach host-only metadata and `setReminder(text)`
 *     to surface a model-visible nudge. `meta` is stripped from model output
 *     via `toModelOutput`; `reminder` stays visible.
 *   - Single-shot `skills` upload: the sandbox becomes the single source of
 *     truth for skills — pass `skills: [{ host, sandbox }]` to upload files
 *     and populate `sandbox.skills` in one shot.
 */
export async function createBashTool(
  options: CreateBashToolWithSkillsOptions = {},
): Promise<AgentSandbox> {
  const { skills: skillInputs = [], extraInstructions, ...rest } = options;
  const externalOptions = {
    ...rest,
    ...(isAbortableJustBash(rest.sandbox)
      ? { sandbox: wrapAbortableJustBash(rest.sandbox) }
      : {}),
  };

  const combinedInstructions = [extraInstructions, REASONING_INSTRUCTION]
    .filter(Boolean)
    .join('\n\n');

  const toolkit = await externalCreateBashTool({
    ...externalOptions,
    extraInstructions: combinedInstructions,
  });

  const innerExecute = toolkit.sandbox.executeCommand.bind(toolkit.sandbox);
  toolkit.sandbox.executeCommand = async (cmd: string) => {
    try {
      return await innerExecute(cmd);
    } catch (err) {
      if (err instanceof BashException) return err.format();
      throw err;
    }
  };

  const upstreamBash = toolkit.bash as unknown as Record<string, unknown> & {
    description?: string;
    execute?: (
      input: { command: string },
      options: unknown,
    ) => Promise<CommandResult>;
  };
  const originalExecute = upstreamBash.execute;

  // `tool()`'s overloads can't reconcile our wider inputSchema with
  // toModelOutput's NoInfer<TOutput> inference — without the cast TS resolves
  // the generic to Tool<never, never>. The cast fixes the inference
  // dead-end; the actual runtime shape is verified by tests.
  const toolBuilder = tool as unknown as (config: unknown) => WrappedBashTool;

  const bash = toolBuilder({
    ...upstreamBash,
    description: upstreamBash.description ?? '',
    inputSchema: z.object({
      command: z.string().describe('The bash command to execute'),
      reasoning: z
        .string()
        .trim()
        .describe('Brief reason for executing this command'),
    }),
    execute: async (
      { command }: { command: string; reasoning: string },
      execOptions: unknown,
    ) => {
      if (!originalExecute) {
        throw new Error('bash tool execution is not available');
      }
      const abortSignal =
        typeof execOptions === 'object' &&
        execOptions !== null &&
        'abortSignal' in execOptions
          ? (execOptions as { abortSignal?: AbortSignal }).abortSignal
          : undefined;

      return bashExecAbortSignal.run(abortSignal, () =>
        runWithBashMeta(async () => {
          let result: CommandResult;
          try {
            result = await originalExecute({ command }, execOptions);
          } catch (err) {
            if (err instanceof BashException) {
              result = err.format();
            } else {
              throw err;
            }
          }
          const state = readBashMeta();
          if (!state) return result;
          const hasHidden = Object.keys(state.hidden).length > 0;
          const hasReminder = state.reminder !== undefined;
          if (!hasHidden && !hasReminder) return result;
          return {
            ...result,
            ...(hasHidden ? { meta: state.hidden } : {}),
            ...(hasReminder ? { reminder: state.reminder } : {}),
          };
        }),
      );
    },
    toModelOutput: ({ output }: { output: unknown }) => {
      if (typeof output !== 'object' || output === null) {
        return { type: 'json' as const, value: output };
      }
      const record = output as Record<string, unknown>;
      if (!('meta' in record)) {
        return { type: 'json' as const, value: record };
      }
      const { meta: _meta, ...visible } = record;
      return { type: 'json' as const, value: visible };
    },
  });

  const skills = await uploadSkills(toolkit.sandbox, skillInputs);

  return {
    ...toolkit,
    bash,
    tools: { ...toolkit.tools, bash },
    skills,
  };
}
