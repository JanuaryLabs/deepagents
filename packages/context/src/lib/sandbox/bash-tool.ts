import { tool } from 'ai';
import {
  type CommandResult,
  type CreateBashToolOptions,
  createBashTool as externalCreateBashTool,
} from 'bash-tool';
import z from 'zod';

import { runWithAbortSignal, withAbortSignal } from './abort.ts';
import { BashException } from './bash-exception.ts';
import { readBashMeta, runWithBashMeta } from './bash-meta.ts';
import {
  type FileChange,
  selfTestStrace,
  traceFileChanges,
} from './file-changes.ts';
import type {
  AgentSandbox,
  DisposableSandbox,
  SkillUploadInput,
  WrappedBashTool,
} from './types.ts';
import { uploadSkills } from './upload-skills.ts';

const REASONING_INSTRUCTION =
  'Every bash tool call must include a brief non-empty "reasoning" input explaining why the command is needed.';

/**
 * Decorator: converts `BashException` thrown from `executeCommand` into a
 * normal `CommandResult` via `BashException.format()`. Other errors pass
 * through unchanged. Stacks on top of `traceFileChanges` so a thrown
 * BashException still lets the tracer collect that command's file changes.
 *
 * Backends must be plain object literals (not class instances) since the
 * spread below copies only own enumerable properties; prototype methods
 * would be lost.
 */
function withBashExceptionCatch(sandbox: DisposableSandbox): DisposableSandbox {
  return {
    ...sandbox,
    async executeCommand(command, options) {
      try {
        return await sandbox.executeCommand(command, options);
      } catch (err) {
        if (err instanceof BashException) return err.format();
        throw err;
      }
    },
  };
}

export interface CreateBashToolWithSkillsOptions extends Omit<
  CreateBashToolOptions,
  'sandbox'
> {
  /**
   * Backend satisfying `DisposableSandbox`. Callers pick the backend
   * explicitly via `createVirtualSandbox`, `createDockerSandbox`, or
   * `createAgentOsSandbox`. `@vercel/sandbox` is intentionally not
   * accepted; if it's needed, wrap it to `DisposableSandbox` first.
   */
  sandbox: DisposableSandbox;
  /**
   * Skill directories to upload into the sandbox at startup. Each entry's
   * contents are copied to `sandbox` (files + subdirectories) and each
   * subdirectory containing a SKILL.md is parsed into `sandbox.skills`.
   */
  skills?: SkillUploadInput[];
  /**
   * Working directory + file-change observation root. Defaults to
   * `/workspace` (matching upstream `bash-tool`). `onFileChanges` reports
   * activity rooted here.
   */
  destination?: string;
  /**
   * Called once per tool-call command (and per `spawn`) with that call's
   * `FileChange[]` — the reactive post-tool effect.
   *
   * File-change tracking is **always on** via `strace`: a self-test runs at
   * startup and throws `StraceUnavailableError` if `strace` is missing, ptrace
   * is blocked, or the trace is unparseable (e.g. emulated arch). The backend
   * must therefore be strace-capable — the in-process virtual sandbox is not.
   */
  onFileChanges?: (changes: FileChange[]) => void | Promise<void>;
}

/**
 * Composes an `AgentSandbox` from a backend by layering decorators:
 *
 *     backend → traceFileChanges → withBashExceptionCatch → withAbortSignal
 *
 * The composed sandbox is handed to upstream `bash-tool`; upstream's
 * internal `bash` / `readFile` / `writeFile` tools therefore close over
 * the decorated methods. The outer `bash` tool adds:
 *
 *   - `reasoning` input on the schema.
 *   - Generic meta channel (`useBashMeta()`): `setHidden(patch)` attaches
 *     host-only metadata; `setReminder(text)` surfaces a model-visible
 *     nudge. `meta` is stripped from model output via `toModelOutput`.
 *   - Single-shot `skills` upload populating `sandbox.skills`.
 */
export async function createBashTool(
  options: CreateBashToolWithSkillsOptions,
): Promise<AgentSandbox> {
  const {
    skills: skillInputs = [],
    extraInstructions,
    sandbox: backend,
    destination,
    onFileChanges,
    ...rest
  } = options;

  const observationRoot = destination ?? '/workspace';
  // File-change tracking is always on via strace. The self-test hard-fails
  // (StraceUnavailableError) on a backend that can't host strace — including the
  // in-process virtual sandbox.
  await selfTestStrace(backend);
  const tracked = traceFileChanges(backend, {
    destination: observationRoot,
    onFileChanges,
  });
  const sandbox = withAbortSignal(withBashExceptionCatch(tracked));

  const combinedInstructions = [extraInstructions, REASONING_INSTRUCTION]
    .filter(Boolean)
    .join('\n\n');

  const toolkit = await externalCreateBashTool({
    ...rest,
    sandbox,
    destination,
    extraInstructions: combinedInstructions,
  });

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
      const { abortSignal } = execOptions as { abortSignal?: AbortSignal };
      return runWithAbortSignal(abortSignal, () =>
        runWithBashMeta(async () => {
          const result = await originalExecute({ command }, execOptions);
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
      const { meta: _meta, ...visible } = output as { meta?: unknown };
      return { type: 'json' as const, value: visible };
    },
  });

  const skills = await uploadSkills(sandbox, skillInputs);

  return {
    ...toolkit,
    sandbox,
    bash,
    tools: { ...toolkit.tools, bash },
    skills,
  };
}
