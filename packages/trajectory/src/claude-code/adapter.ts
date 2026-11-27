import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  Adapter,
  Diagnostic,
  ReadOptions,
  ReadResult,
} from '../adapter.ts';
import {
  ATIF_SCHEMA_VERSION,
  type AgentStep,
  type ContentPart,
  type FinalMetrics,
  type Metrics,
  type ObservationResult,
  type Step,
  type Trajectory,
} from '../atif.ts';
import { SessionReadError } from '../errors.ts';
import { ClaudeCodeSession, ClaudeCodeSubagent } from './session.ts';

type Entry = Record<string, unknown>;

/** Reads a Claude Code transcript into an ATIF v1.8 trajectory, as ADR 0004 maps each entry. */
export class ClaudeCodeAdapter implements Adapter<
  ClaudeCodeSession | ClaudeCodeSubagent
> {
  readonly agent = 'claude-code';

  async read(
    session: ClaudeCodeSession | ClaudeCodeSubagent,
    options: ReadOptions = {},
  ): Promise<ReadResult> {
    const path = session.transcriptPath;
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (cause) {
      throw new SessionReadError(path, 'could not read the transcript', {
        cause,
      });
    }

    const diagnostics: Diagnostic[] = [];
    const steps: Step[] = [];
    const messages = new Map<string, { step: AgentStep; claudeCode: Entry }>();
    const calls = new Map<string, AgentStep>();
    const meta: Entry = {};
    const unmapped = new Map<string, number>();
    let version: string | undefined;
    const isMain = session instanceof ClaudeCodeSession;
    for (const { entry, line } of entries(text, path, diagnostics)) {
      version ??= stringOr(entry.version);
      if (isMain && entry.isSidechain === true) {
        diagnostics.push({
          code: 'sidechain_entry',
          path,
          line,
          message:
            'an isSidechain row inside a main transcript belongs to a subagent',
        });
        continue;
      }
      if (entry.type === 'assistant') {
        const step = agentStep(entry, messages, steps.length + 1);
        if (step.step_id === steps.length + 1) steps.push(step);
        for (const call of step.tool_calls ?? [])
          calls.set(call.tool_call_id, step);
      } else if (entry.type === 'user' && toolResults(entry).length > 0) {
        for (const block of toolResults(entry)) {
          const id = stringOr(block.tool_use_id) ?? '';
          const caller = calls.get(id);
          if (!caller) {
            diagnostics.push({
              code: 'orphan_tool_result',
              path,
              line,
              message: `no call ${id} in the transcript for this tool result`,
            });
            continue;
          }
          caller.observation ??= { results: [] };
          caller.observation.results.push(observationResult(entry, block));
        }
      } else if (entry.type === 'user') {
        steps.push(personStep(entry, steps.length + 1));
      } else if (
        entry.type === 'attachment' &&
        record(entry.attachment)?.type === 'queued_command'
      ) {
        steps.push(queuedStep(entry, steps.length + 1));
      } else if (entry.type === 'attachment') {
        steps.push(attachmentStep(entry, steps.length + 1));
      } else if (entry.type === 'system') {
        steps.push(systemRowStep(entry, steps.length + 1));
      } else if (!collectSessionEntry(entry, meta)) {
        const type = stringOr(entry.type) ?? '(no type)';
        unmapped.set(type, (unmapped.get(type) ?? 0) + 1);
      }
    }
    for (const [entryType, count] of unmapped) {
      diagnostics.push({
        code: 'unmapped_entry',
        path,
        entryType,
        count,
        message: `${count} ${entryType} entries are bookkeeping with no step`,
      });
    }

    const [first, ...rest] = steps;
    if (!first) {
      throw new SessionReadError(path, 'the transcript holds no step');
    }
    const model = steps.find(
      (step): step is AgentStep =>
        step.source === 'agent' && step.model_name != null,
    )?.model_name;
    const trajectory: Trajectory = {
      schema_version: ATIF_SCHEMA_VERSION,
      ...(isMain
        ? {
            session_id: session.runId,
            ...(session.continuedBy
              ? { continued_trajectory_ref: session.continuedBy }
              : {}),
          }
        : {
            session_id: session.sessionId,
            trajectory_id: session.trajectoryId,
          }),
      agent: {
        name: this.agent,
        version: version ?? 'unknown',
        ...(model ? { model_name: model } : {}),
      },
      steps: [first, ...rest],
      final_metrics: finalMetrics(steps),
      ...(Object.keys(meta).length > 0 ? { extra: { claude_code: meta } } : {}),
    };
    if (isMain && options.subagents !== false) {
      const embedded = await this.#subagents(session, trajectory, diagnostics);
      if (embedded.length > 0) trajectory.subagent_trajectories = embedded;
    }
    return { trajectory, diagnostics };
  }

  /**
   * Each `<session>/subagents/agent-*.jsonl`, in name order, as an embedded
   * trajectory. The spawning call's result refers to it through the meta
   * file's `toolUseId`, searched in the root and in every other subagent, so a
   * subagent that another subagent started links too.
   */
  async #subagents(
    session: ClaudeCodeSession,
    root: Trajectory,
    diagnostics: Diagnostic[],
  ): Promise<Trajectory[]> {
    let names: string[];
    try {
      names = await readdir(session.subagentsPath);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT') return [];
      throw new SessionReadError(
        session.subagentsPath,
        'could not list the subagents',
        {
          cause: error,
        },
      );
    }
    const embedded: { subagent: ClaudeCodeSubagent; trajectory: Trajectory }[] =
      [];
    for (const name of names
      .filter((file) => /^agent-.+\.jsonl$/.test(file))
      .toSorted()) {
      const subagent = ClaudeCodeSubagent.fromTranscriptPath(
        join(session.subagentsPath, name),
      );
      try {
        const result = await this.read(subagent, { subagents: false });
        diagnostics.push(...result.diagnostics);
        embedded.push({ subagent, trajectory: result.trajectory });
      } catch (error) {
        if (!(error instanceof SessionReadError)) throw error;
        diagnostics.push({
          code: 'unreadable_subagent',
          path: subagent.transcriptPath,
          message: error.message,
        });
      }
    }

    const results = new Map<string, ObservationResult>();
    for (const trajectory of [
      root,
      ...embedded.map((entry) => entry.trajectory),
    ]) {
      for (const step of trajectory.steps) {
        for (const result of step.observation?.results ?? []) {
          if (result.source_call_id) results.set(result.source_call_id, result);
        }
      }
    }
    for (const { subagent, trajectory } of embedded) {
      const spawnedBy = stringOr(
        record(await readJson(subagent.metaPath))?.toolUseId,
      );
      const result = spawnedBy ? results.get(spawnedBy) : undefined;
      if (!result) {
        diagnostics.push({
          code: 'unlinked_subagent',
          path: subagent.transcriptPath,
          message: spawnedBy
            ? `no result of call ${spawnedBy} spawned this subagent`
            : 'no meta file names the call that spawned this subagent',
        });
        continue;
      }
      result.subagent_trajectory_ref = [
        ...(result.subagent_trajectory_ref ?? []),
        {
          trajectory_id: trajectory.trajectory_id,
          session_id: trajectory.session_id,
        },
      ];
    }
    return embedded.map((entry) => entry.trajectory);
  }
}

/**
 * A `user` entry that carries words, not tool results. An explicit `origin`
 * makes it a user step with that origin, `isMeta` or not (peer messages are
 * stored with both). `isMeta` with no origin is injected context (a skill
 * body, a command expansion): a system step. A text entry with neither comes
 * from a build before `origin`: a user step with no origin, so it never counts
 * as typed (ADR 0004 and its amendment).
 */
function personStep(entry: Entry, stepId: number): Step {
  const origin = record(entry.origin)?.kind;
  const isMeta = entry.isMeta === true;
  const message = textOf(record(entry.message)?.content);
  const claudeCode = {
    ...identity(entry),
    ...(typeof origin === 'string' ? { origin } : {}),
    ...(isMeta ? { is_meta: true } : {}),
  };
  const source = typeof origin === 'string' || !isMeta ? 'user' : 'system';
  return {
    step_id: stepId,
    source,
    timestamp: stringOr(entry.timestamp),
    message,
    extra: { claude_code: claudeCode },
  };
}

/**
 * Claude Code writes each content block of one assistant message as its own
 * entry, repeating the message id and its usage. They merge into one agent
 * step: text and thinking accumulate, each `tool_use` becomes a tool call,
 * and the latest usage becomes the metrics, summed as meticulous's
 * `usageToMetrics` does (ATIF's `prompt_tokens` counts every input token).
 */
function agentStep(
  entry: Entry,
  messages: Map<string, { step: AgentStep; claudeCode: Entry }>,
  nextStepId: number,
): AgentStep {
  const message = record(entry.message) ?? {};
  const id = stringOr(message.id) ?? stringOr(entry.uuid) ?? String(nextStepId);
  let known = messages.get(id);
  if (!known) {
    const claudeCode: Entry = { ...identity(entry), message_id: id };
    known = {
      claudeCode,
      step: {
        step_id: nextStepId,
        source: 'agent',
        timestamp: stringOr(entry.timestamp),
        message: '',
        extra: { claude_code: claudeCode },
      },
    };
    messages.set(id, known);
  }
  const { step, claudeCode } = known;
  const model = stringOr(message.model);
  if (model && model !== SYNTHETIC_MODEL) step.model_name = model;
  const requestId = stringOr(entry.requestId);
  if (requestId) claudeCode.request_id = requestId;
  const stopReason = stringOr(message.stop_reason);
  if (stopReason) claudeCode.stop_reason = stopReason;
  const usage = record(message.usage);
  if (usage) step.metrics = metricsOf(usage);

  for (const block of Array.isArray(message.content) ? message.content : []) {
    const part = record(block);
    if (part?.type === 'text' && typeof part.text === 'string') {
      step.message =
        step.message === ''
          ? part.text
          : `${String(step.message)}\n${part.text}`;
    } else if (part?.type === 'thinking' && typeof part.thinking === 'string') {
      step.reasoning_content =
        step.reasoning_content == null
          ? part.thinking
          : `${step.reasoning_content}\n${part.thinking}`;
    } else if (part?.type === 'tool_use') {
      step.tool_calls ??= [];
      step.tool_calls.push({
        tool_call_id: stringOr(part.id) ?? '',
        function_name: stringOr(part.name) ?? '',
        arguments: record(part.input) ?? {},
      });
    }
  }
  return step;
}

/** Claude Code's placeholder model for messages it writes itself (meticulous's `SYNTHETIC_MODEL`). */
const SYNTHETIC_MODEL = '<synthetic>';

function metricsOf(usage: Entry): Metrics {
  const input = numberOr(usage.input_tokens);
  const cacheCreation = numberOr(usage.cache_creation_input_tokens);
  const cacheRead = numberOr(usage.cache_read_input_tokens);
  return {
    prompt_tokens: input + cacheCreation + cacheRead,
    completion_tokens: numberOr(usage.output_tokens),
    cached_tokens: cacheRead,
    extra: {
      input_tokens: input,
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
    },
  };
}

function toolResults(entry: Entry): Entry[] {
  const content = record(entry.message)?.content;
  return Array.isArray(content)
    ? content.flatMap((block) =>
        isRecord(block) && block.type === 'tool_result' ? [block] : [],
      )
    : [];
}

/** One tool's result, with Claude Code's structured `toolUseResult` kept in `extra`. */
function observationResult(entry: Entry, block: Entry): ObservationResult {
  const content =
    typeof block.content === 'string'
      ? block.content
      : textParts(block.content);
  return {
    source_call_id: stringOr(block.tool_use_id),
    content,
    extra: {
      claude_code: {
        ...identity(entry),
        is_error: block.is_error === true,
        ...(entry.toolUseResult === undefined
          ? {}
          : { tool_use_result: entry.toolUseResult }),
      },
    },
  };
}

function textParts(content: unknown): ContentPart[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): ContentPart[] =>
    isRecord(block) && block.type === 'text' && typeof block.text === 'string'
      ? [{ type: 'text', text: block.text }]
      : [],
  );
}

function numberOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Any attachment but a queued prompt: a system step that carries it (hook output, snapshots, …). */
function attachmentStep(entry: Entry, stepId: number): Step {
  const attachment = record(entry.attachment) ?? {};
  const content = attachment.content;
  let message = '';
  if (Array.isArray(content)) {
    message = content.filter((part) => typeof part === 'string').join('\n');
  } else if (typeof content === 'string') {
    message = content;
  }
  return {
    step_id: stepId,
    source: 'system',
    timestamp: stringOr(entry.timestamp),
    message,
    extra: { claude_code: { ...identity(entry), attachment } },
  };
}

/** A `system` row (stop_hook_summary, turn_duration, compact_boundary, …): a system step that carries it. */
function systemRowStep(entry: Entry, stepId: number): Step {
  return {
    step_id: stepId,
    source: 'system',
    timestamp: stringOr(entry.timestamp),
    message: typeof entry.content === 'string' ? entry.content : '',
    extra: { claude_code: { ...identity(entry), system: entry } },
  };
}

/** Session-level entries go to the trajectory's extra; returns false for any other entry. */
function collectSessionEntry(entry: Entry, meta: Entry): boolean {
  switch (entry.type) {
    case 'derived-from':
      meta.derived_from = Array.isArray(entry.sessions) ? entry.sessions : [];
      return true;
    case 'ai-title':
      if (typeof entry.aiTitle === 'string') meta.ai_title = entry.aiTitle;
      return true;
    case 'custom-title':
      if (typeof entry.customTitle === 'string')
        meta.custom_title = entry.customTitle;
      return true;
    case 'summary':
      if (typeof entry.summary === 'string') {
        const summaries = Array.isArray(meta.summaries) ? meta.summaries : [];
        meta.summaries = [...summaries, entry.summary];
      }
      return true;
    case 'pr-link': {
      const links = Array.isArray(meta.pr_links) ? meta.pr_links : [];
      meta.pr_links = [...links, entry];
      return true;
    }
    default:
      return false;
  }
}

function finalMetrics(steps: Step[]): FinalMetrics {
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  for (const step of steps) {
    if (step.source !== 'agent' || !step.metrics) continue;
    prompt += step.metrics.prompt_tokens ?? 0;
    completion += step.metrics.completion_tokens ?? 0;
    cached += step.metrics.cached_tokens ?? 0;
  }
  return {
    total_prompt_tokens: prompt,
    total_completion_tokens: completion,
    total_cached_tokens: cached,
    total_steps: steps.length,
  };
}

/** A prompt delivered while the agent works: a user step with the attachment's own origin. */
function queuedStep(entry: Entry, stepId: number): Step {
  const attachment = record(entry.attachment) ?? {};
  const origin = record(attachment.origin)?.kind;
  return {
    step_id: stepId,
    source: 'user',
    timestamp: stringOr(entry.timestamp),
    message: typeof attachment.prompt === 'string' ? attachment.prompt : '',
    extra: {
      claude_code: {
        ...identity(entry),
        ...(typeof origin === 'string' ? { origin } : {}),
        queued: true,
      },
    },
  };
}

/** The keys that join a step back to its raw line (ADR 0004). */
function identity(entry: Entry): Entry {
  const keys = {
    uuid: entry.uuid,
    parent_uuid: entry.parentUuid,
    timestamp: entry.timestamp,
    cwd: entry.cwd,
    entrypoint: entry.entrypoint,
    prompt_id: entry.promptId,
  };
  return Object.fromEntries(
    Object.entries(keys).filter(([, value]) => value !== undefined),
  );
}

/** A message's words: the string itself, or its text blocks joined by newlines. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        ? [block.text]
        : [],
    )
    .join('\n');
}

function isRecord(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Entry | undefined {
  return isRecord(value) ? value : undefined;
}

function errnoCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Each line that parses as a JSON object, with its 1-based line number. A
 * line that does not is a diagnostic: `partial_last_line` when it is the last
 * line and no newline ends it (the agent is still writing it), else
 * `invalid_json_line`.
 */
function* entries(
  text: string,
  path: string,
  diagnostics: Diagnostic[],
): Generator<{ entry: Entry; line: number }> {
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    if (raw.trim() === '') continue;
    const line = index + 1;
    const entry = parseObject(raw);
    if (entry) {
      yield { entry, line };
    } else if (index === lines.length - 1) {
      diagnostics.push({
        code: 'partial_last_line',
        path,
        line,
        message:
          'the last line is not yet complete JSON; the agent may still be writing it',
      });
    } else {
      diagnostics.push({
        code: 'invalid_json_line',
        path,
        line,
        message: 'the line is not a JSON object',
      });
    }
  }
}

function parseObject(raw: string): Entry | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return record(value);
  } catch {
    return undefined;
  }
}

/** A JSON file's value, or undefined when it is missing or does not parse. */
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}
