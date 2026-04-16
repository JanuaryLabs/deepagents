import type { LanguageModelV3 } from '@ai-sdk/provider';
import { APICallError, type LanguageModelUsage, type Tool } from 'ai';

import type { ContextFragment } from './fragments.ts';

export type AgentModel = LanguageModelV3;

export type AdvisorErrorCode =
  | 'max_uses_exceeded'
  | 'too_many_requests'
  | 'overloaded'
  | 'prompt_too_long'
  | 'execution_time_exceeded'
  | 'unavailable';

export interface AdvisorUsage {
  calls: number;
  totalUsage: LanguageModelUsage;
}

export interface AdvisorResult {
  tool: Tool<Record<string, never>, string>;
  usage: () => AdvisorUsage;
}

export interface AsAdvisorOptions {
  maxUses?: number;
  maxConversationUses?: number;
  maxOutputTokens?: number;
}

const PREAMBLE_TEXT = `You are an advisor providing strategic guidance to a task executor. You can see the executor's full conversation history including all tool calls and results. Provide concise, actionable advice. Do not execute tools yourself — only advise on strategy, approach, and next steps.`;

const TIMING_TEXT = `You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters — when you call advisor(), your entire conversation history is automatically forwarded. They see the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work — before writing, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, fetching a source, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, save the result, commit the change. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck — errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling — the advisor adds most of its value on the first call, before the approach crystallizes.`;

const TREATMENT_TEXT = `Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the paper states Y), adapt. A passing self-test is not evidence the advice is wrong — it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call — "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.`;

export function advisorPreamble(): ContextFragment {
  return {
    name: 'advisor_preamble',
    data: PREAMBLE_TEXT,
    codec: {
      encode() {
        return { type: 'advisor_preamble', text: PREAMBLE_TEXT };
      },
      decode() {
        return PREAMBLE_TEXT;
      },
    },
  };
}

export function advisorTiming(): ContextFragment {
  return {
    name: 'advisor_timing',
    data: TIMING_TEXT,
    codec: {
      encode() {
        return { type: 'advisor_timing', text: TIMING_TEXT };
      },
      decode() {
        return TIMING_TEXT;
      },
    },
  };
}

export function advisorTreatment(): ContextFragment {
  return {
    name: 'advisor_treatment',
    data: TREATMENT_TEXT,
    codec: {
      encode() {
        return { type: 'advisor_treatment', text: TREATMENT_TEXT };
      },
      decode() {
        return TREATMENT_TEXT;
      },
    },
  };
}

export function executorContext(systemPrompt: string): ContextFragment {
  return {
    name: 'executor_context',
    data: systemPrompt,
    codec: {
      encode() {
        return { type: 'executor_context', systemPrompt };
      },
      decode() {
        return systemPrompt;
      },
    },
  };
}

function addTokens(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}

export function addUsage(
  accumulated: LanguageModelUsage,
  incoming: LanguageModelUsage,
): LanguageModelUsage {
  return {
    inputTokens: addTokens(accumulated.inputTokens, incoming.inputTokens),
    inputTokenDetails: {
      noCacheTokens: addTokens(
        accumulated.inputTokenDetails?.noCacheTokens,
        incoming.inputTokenDetails?.noCacheTokens,
      ),
      cacheReadTokens: addTokens(
        accumulated.inputTokenDetails?.cacheReadTokens,
        incoming.inputTokenDetails?.cacheReadTokens,
      ),
      cacheWriteTokens: addTokens(
        accumulated.inputTokenDetails?.cacheWriteTokens,
        incoming.inputTokenDetails?.cacheWriteTokens,
      ),
    },
    outputTokens: addTokens(accumulated.outputTokens, incoming.outputTokens),
    outputTokenDetails: {
      textTokens: addTokens(
        accumulated.outputTokenDetails?.textTokens,
        incoming.outputTokenDetails?.textTokens,
      ),
      reasoningTokens: addTokens(
        accumulated.outputTokenDetails?.reasoningTokens,
        incoming.outputTokenDetails?.reasoningTokens,
      ),
    },
    totalTokens: addTokens(accumulated.totalTokens, incoming.totalTokens),
  };
}

export function nullUsage(): LanguageModelUsage {
  return {
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: undefined,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    totalTokens: undefined,
  };
}

export function mapGenerateErrorToCode(
  error: unknown,
): AdvisorErrorCode | null {
  if (error instanceof Error && error.name === 'AbortError') {
    return null;
  }

  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'execution_time_exceeded';
  }

  if (APICallError.isInstance(error)) {
    const msg = error.message.toLowerCase();
    if (error.statusCode === 429) return 'too_many_requests';
    if (error.statusCode === 503 || error.statusCode === 529)
      return 'overloaded';
    if (
      error.statusCode === 413 ||
      msg.includes('context_length_exceeded') ||
      msg.includes('prompt is too long')
    )
      return 'prompt_too_long';
    if (
      error.statusCode !== undefined &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return null;
    return 'unavailable';
  }

  return null;
}
