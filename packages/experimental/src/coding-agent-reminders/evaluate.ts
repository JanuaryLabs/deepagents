import { ClaudeCodeAdapter, ClaudeCodeSession } from '@deepagents/trajectory';

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

/**
 * The additional context that hooks added since the last human turn, read
 * through @deepagents/trajectory from the newest step back. A continued stop
 * whose transcript is unnamed, missing, unreadable or holds no step cannot
 * show that a rule has not fed back yet, so it throws, and the rule does not
 * fire.
 */
async function feedbackSinceHumanTurn(
  transcriptPath: string | undefined,
): Promise<string[]> {
  if (transcriptPath === undefined) {
    throw new Error(
      'The continued stop has no transcript_path, so the chain feedback cannot be read.',
    );
  }
  const { trajectory } = await new ClaudeCodeAdapter().read(
    ClaudeCodeSession.fromTranscriptPath(transcriptPath),
    { subagents: false },
  );
  const feedback: string[] = [];
  for (const step of trajectory.steps.toReversed()) {
    const claudeCode = step.extra?.claude_code;
    if (!isRecord(claudeCode)) continue;
    if (
      step.source === 'user' &&
      claudeCode.origin === 'human' &&
      claudeCode.queued !== true
    )
      break;
    const { attachment } = claudeCode;
    if (
      step.source === 'system' &&
      isRecord(attachment) &&
      attachment.type === 'hook_additional_context' &&
      Array.isArray(attachment.content)
    ) {
      feedback.push(
        ...attachment.content.filter(
          (part): part is string => typeof part === 'string',
        ),
      );
    }
  }
  return feedback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
