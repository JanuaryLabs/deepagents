import {
  type AtifMessageContent,
  type AtifStep,
  type AtifTrajectory,
  type RolloutFileText,
  convertCodexSession,
  parseRolloutFileName,
} from '@alwaysmeticulous/agent-traces';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import type { Adapter, ReadOptions, ReadResult } from '../adapter.ts';
import {
  ATIF_SCHEMA_VERSION,
  type ContentPart,
  type ImageSource,
  type Observation,
  type Step,
  type Trajectory,
} from '../atif.ts';
import { SessionReadError } from '../errors.ts';
import type { CodexThread } from './thread.ts';

/** The converter version meticulous records in what it builds. */
const CONVERTER = '@deepagents/trajectory';

/**
 * Reads a Codex thread into an ATIF v1.8 trajectory through meticulous's
 * `convertCodexSession` (ADR 0003): it tells typed prompts from injected
 * context, pairs calls with outputs and links subagent threads. This adapter
 * decodes `.jsonl.zst`, which meticulous does not, and maps its v1.7 types
 * onto this package's.
 */
export class CodexAdapter implements Adapter<CodexThread> {
  readonly agent = 'codex';

  async read(
    thread: CodexThread,
    options: ReadOptions = {},
  ): Promise<ReadResult> {
    const root = await Promise.all(thread.rolloutPaths.map(rolloutText));
    const subagents =
      options.subagents === false
        ? []
        : await Promise.all(
            thread.subagents.map(async (subagent) => ({
              threadId: subagent.threadId,
              files: await Promise.all(subagent.rolloutPaths.map(rolloutText)),
            })),
          );
    const { trajectory } = convertCodexSession(
      {
        sessionId: thread.threadId,
        root,
        subagents,
        threadName: null,
        readFallbackGitBranch: () => null,
      },
      CONVERTER,
    );
    const converted = toTrajectory(trajectory);
    if (!converted) {
      throw new SessionReadError(
        thread.rolloutPaths[0] ?? thread.threadId,
        'the rollout holds no step',
      );
    }
    return { trajectory: converted, diagnostics: [] };
  }
}

async function rolloutText(path: string): Promise<RolloutFileText> {
  let text: string;
  try {
    const bytes = await readFile(path);
    text = (path.endsWith('.zst') ? zstdDecompressSync(bytes) : bytes).toString(
      'utf8',
    );
  } catch (cause) {
    throw new SessionReadError(path, 'could not read or decode the rollout', {
      cause,
    });
  }
  const name = basename(path).replace(/\.zst$/, '');
  return { rolloutId: parseRolloutFileName(name)?.rolloutId ?? name, text };
}

/** meticulous's v1.7 document as this package's v1.8 one, or undefined when it has no step. */
function toTrajectory(source: AtifTrajectory): Trajectory | undefined {
  const [first, ...rest] = source.steps.map(toStep);
  if (!first) return undefined;
  const subagents = (source.subagent_trajectories ?? []).flatMap((sub) => {
    const converted = toTrajectory(sub);
    return converted ? [converted] : [];
  });
  return {
    schema_version: ATIF_SCHEMA_VERSION,
    session_id: source.session_id,
    trajectory_id: source.trajectory_id,
    agent: {
      name: source.agent.name,
      version: source.agent.version,
      model_name: source.agent.model_name,
      tool_definitions: source.agent.tool_definitions?.flatMap((tool) =>
        isRecord(tool) ? [tool] : [],
      ),
      extra: source.agent.extra,
    },
    steps: [first, ...rest],
    notes: source.notes,
    final_metrics: source.final_metrics,
    continued_trajectory_ref: source.continued_trajectory_ref,
    extra: source.extra,
    ...(subagents.length > 0 ? { subagent_trajectories: subagents } : {}),
  };
}

function toStep(step: AtifStep): Step {
  const base = {
    step_id: step.step_id,
    timestamp: step.timestamp,
    message: toMessage(step.message),
    observation: toObservation(step.observation),
    is_copied_context: step.is_copied_context,
    llm_call_count: step.llm_call_count,
    extra: step.extra,
  };
  switch (step.source) {
    case 'agent':
      return {
        ...base,
        source: 'agent',
        model_name: step.model_name,
        reasoning_effort: step.reasoning_effort,
        reasoning_content: step.reasoning_content,
        tool_calls: step.tool_calls,
        metrics: step.metrics,
      };
    case 'user':
      return { ...base, source: 'user' };
    case 'system':
      return { ...base, source: 'system' };
  }
}

function toObservation(
  observation: AtifStep['observation'],
): Observation | undefined {
  if (!observation) return undefined;
  return {
    results: observation.results.map((result) => ({
      source_call_id: result.source_call_id,
      content:
        result.content === undefined ? undefined : toMessage(result.content),
      subagent_trajectory_ref: result.subagent_trajectory_ref,
      extra: result.extra,
    })),
  };
}

/** Text as it is; an image keeps its source when ATIF names its type, else becomes text that names it. */
function toMessage(message: AtifMessageContent): string | ContentPart[] {
  if (typeof message === 'string') return message;
  return message.map((part): ContentPart => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    const source = imageSource(part.source.media_type, part.source.path);
    return source
      ? { type: 'image', source }
      : {
          type: 'text',
          text: `[image ${part.source.media_type}: ${part.source.path}]`,
        };
  });
}

function imageSource(mediaType: string, path: string): ImageSource | undefined {
  switch (mediaType) {
    case 'image/jpeg':
    case 'image/png':
    case 'image/gif':
    case 'image/webp':
      return { media_type: mediaType, path };
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
