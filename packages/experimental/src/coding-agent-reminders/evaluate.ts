import type {
  ClaudeHookInput,
  ClaudeHookOutput,
  GuardRule,
  HookEventName,
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

  if (
    input.stop_hook_active === true &&
    (input.hook_event_name === 'Stop' ||
      input.hook_event_name === 'SubagentStop')
  ) {
    return undefined;
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
  const matched: string[] = [];
  for (const rule of reminders) {
    if (!rule.events.includes(input.hook_event_name as HookEventName)) continue;
    try {
      if (!(await rule.when(input))) continue;
      matched.push(
        `[${rule.target}:${rule.id}]\n${resolveText(rule.message, input)}`,
      );
    } catch (error) {
      console.error(`Reminder "${rule.id}" evaluation failed`, error);
    }
  }
  return matched;
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
