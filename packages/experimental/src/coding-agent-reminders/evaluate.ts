import { readFile } from 'node:fs/promises';
import { z } from 'zod';

import type {
  ClaudeHookInput,
  ClaudeHookOutput,
  GuardRule,
  ReminderHookConfig,
  ReminderRule,
} from './types.ts';

export async function evaluateReminderHook(
  input: ClaudeHookInput,
  config: ReminderHookConfig,
): Promise<ClaudeHookOutput | undefined> {
  const guardMatch =
    input.hook_event_name === 'PreToolUse'
      ? await firstMatchingGuard(input, config.guards)
      : undefined;
  if (guardMatch) {
    return {
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        permissionDecision: 'deny',
        permissionDecisionReason:
          guardMatch.errorReason ?? resolveGuardReason(guardMatch.rule, input),
      },
    };
  }

  const reminders = await matchingReminders(input, config.reminders);
  if (reminders.length === 0) return undefined;

  return {
    hookSpecificOutput: {
      hookEventName: input.hook_event_name,
      additionalContext: reminders.join('\n\n'),
    },
  };
}

async function firstMatchingGuard(
  input: ClaudeHookInput,
  guards: GuardRule[],
): Promise<{ rule: GuardRule; errorReason?: string } | undefined> {
  for (const rule of guards) {
    try {
      if (await rule.when(input)) return { rule };
    } catch (error) {
      console.error(`Guard "${rule.id}" predicate failed`, error);
      return {
        rule,
        errorReason: `Guard "${rule.id}" failed to evaluate; denying by default.`,
      };
    }
  }
  return undefined;
}

async function matchingReminders(
  input: ClaudeHookInput,
  reminders: ReminderRule[],
): Promise<string[]> {
  const continued =
    input.stop_hook_active === true &&
    (input.hook_event_name === 'Stop' ||
      input.hook_event_name === 'SubagentStop');
  let chainFeedback: Promise<string[]> | undefined;
  const matched: string[] = [];
  for (const rule of reminders) {
    if (!rule.events.some((event) => event === input.hook_event_name)) continue;
    if (continued && rule.continuedStops !== 'once') continue;
    const marker = `[${rule.target}:${rule.id}]`;
    try {
      if (continued) {
        chainFeedback ??= feedbackSinceHumanTurn(input.transcript_path);
        if (hasMarker(await chainFeedback, marker)) continue;
      }
      if (!(await rule.when(input))) continue;
      matched.push(`${marker}\n${resolveText(rule.message, input)}`);
    } catch (error) {
      console.error(`Reminder "${rule.id}" evaluation failed`, error);
    }
  }
  return matched;
}

const transcriptLine = z.union([
  z.object({
    type: z.literal('user'),
    origin: z.object({ kind: z.literal('human') }),
  }),
  z.object({
    type: z.literal('attachment'),
    attachment: z.object({
      type: z.literal('hook_additional_context'),
      content: z.array(z.string()),
    }),
  }),
]);

/**
 * The additional context that hooks added since the last human turn, read
 * from the newest transcript line back. A continued stop that names no
 * transcript cannot show that a rule has not fed back yet, so it throws, and
 * the rule does not fire.
 */
async function feedbackSinceHumanTurn(
  transcriptPath: string | undefined,
): Promise<string[]> {
  if (transcriptPath === undefined) {
    throw new Error(
      'The continued stop has no transcript_path, so the chain feedback cannot be read.',
    );
  }
  const lines = (await readFile(transcriptPath, 'utf8')).split('\n');
  const feedback: string[] = [];
  for (const line of lines.toReversed()) {
    const parsed = transcriptLine.safeParse(parseJsonLine(line));
    if (!parsed.success) continue;
    if (parsed.data.type === 'user') break;
    feedback.push(...parsed.data.attachment.content);
  }
  return feedback;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    // An empty line, or the last line while Claude Code still writes it.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function hasMarker(feedback: string[], marker: string): boolean {
  return feedback.some((text) => text.split('\n').includes(marker));
}

function resolveText(
  value: string | ((ctx: ClaudeHookInput) => string),
  input: ClaudeHookInput,
): string {
  return typeof value === 'function' ? value(input) : value;
}

function resolveGuardReason(rule: GuardRule, input: ClaudeHookInput): string {
  try {
    return resolveText(rule.deny, input);
  } catch (error) {
    console.error(`Guard "${rule.id}" denial message failed`, error);
    return `Guard "${rule.id}" matched but its denial message failed; denying by default.`;
  }
}
