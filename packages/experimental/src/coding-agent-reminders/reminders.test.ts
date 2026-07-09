import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as reminderApi from '@deepagents/experimental/coding-agent-reminders';
import {
  type ClaudeHookInput,
  and,
  contentIncludes,
  contentMatches,
  contentPattern,
  evaluateReminderHook,
  not,
  or,
  outputMatches,
  toolCall,
  toolCallCount,
  toolFailed,
} from '@deepagents/experimental/coding-agent-reminders';

test('package declares classifier runtime dependencies directly', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { dependencies?: Record<string, string> };

  assert.equal(packageJson.dependencies?.['tiny-tfidf'], '^1.0.0');
});

test('raw hook API omits predicates that require external session enrichment', () => {
  for (const name of [
    'everyNTurns',
    'first',
    'firstN',
    'afterTurn',
    'elapsedExceeds',
    'usageExceeds',
  ]) {
    assert.equal(name in reminderApi, false, `${name} must not be exported`);
  }
});

test('content predicates inspect Claude prompt text', async () => {
  const ctx: ClaudeHookInput = {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Fix the failing database migration',
  };

  assert.equal(await contentIncludes(['database'])(ctx), true);
  assert.equal(await contentPattern(/\bfailing\b/i)(ctx), true);
  assert.equal(
    await contentMatches(['schema migration failure'], { threshold: 0 })(ctx),
    true,
  );
});

test('combinators preserve DeepAgents short-circuit semantics', async () => {
  const ctx: ClaudeHookInput = { hook_event_name: 'UserPromptSubmit' };
  let reached = false;

  assert.equal(
    await and(
      () => false,
      () => {
        reached = true;
        return true;
      },
    )(ctx),
    false,
  );
  assert.equal(reached, false);
  assert.equal(
    await or(
      () => false,
      () => true,
    )(ctx),
    true,
  );
  assert.equal(await not(() => true)(ctx), false);
});

test('tool predicates inspect the current Claude tool event', async () => {
  const success: ClaudeHookInput = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_output: 'Error: permission denied',
  };
  const failure: ClaudeHookInput = {
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    tool_output: 'permission denied',
  };

  assert.equal(
    await toolCall({
      name: 'Bash',
      output: (output) => String(output).includes('permission denied'),
    })(success),
    true,
  );
  assert.equal(await toolFailed('Bash')(failure), true);
  assert.equal(await toolCallCount('Bash', { eq: 1 })(success), true);
});

test('tool predicates inspect every call in a PostToolBatch fixture', async () => {
  const batch: ClaudeHookInput = {
    hook_event_name: 'PostToolBatch',
    tool_calls: [
      {
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/a.ts' },
        tool_use_id: 'toolu_read',
        tool_response: 'alpha',
      },
      {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_use_id: 'toolu_bash_1',
        tool_response: 'first passed',
      },
      {
        tool_name: 'Bash',
        tool_input: { command: 'npm run lint' },
        tool_use_id: 'toolu_bash_2',
        tool_response: 'second passed',
      },
    ],
  };

  assert.equal(await toolCallCount('Bash', { eq: 2 })(batch), true);
  assert.equal(
    await toolCall({
      name: 'Read',
      input: (input) =>
        (input as { file_path?: string }).file_path === '/tmp/a.ts',
      output: (output) => output === 'alpha',
    })(batch),
    true,
  );
  assert.equal(await outputMatches(/second passed/)(batch), true);
});

test('evaluateReminderHook returns guard output before reminders', async () => {
  const output = await evaluateReminderHook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'unsafe-command' },
    },
    {
      guards: [
        {
          id: 'test-guard',
          when: toolCall({
            name: 'Bash',
            input: (input) =>
              typeof input === 'object' &&
              input !== null &&
              'command' in input &&
              input.command === 'unsafe-command',
          }),
          deny: 'Blocked by test policy.',
        },
      ],
      reminders: [
        {
          id: 'unused',
          target: 'tool-result',
          events: ['PreToolUse'],
          when: () => true,
          message: 'should not be emitted',
        },
      ],
    },
  );

  assert.deepEqual(output, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Blocked by test policy.',
    },
  });
});

test('a throwing guard predicate denies the tool call instead of failing open', async () => {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const output = await evaluateReminderHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'unsafe-command' },
      },
      {
        reminders: [],
        guards: [
          {
            id: 'throws',
            when: () => {
              throw new Error('broken predicate');
            },
            deny: 'unused',
          },
        ],
      },
    );

    assert.deepEqual(output, {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Guard "throws" failed to evaluate; denying by default.',
      },
    });
  } finally {
    console.error = originalError;
  }
});

test('Stop feedback does not fire again while a stop hook continuation is active', async () => {
  const config = {
    guards: [],
    reminders: [
      {
        id: 'verify-before-stop',
        target: 'stop-feedback' as const,
        events: ['Stop' as const],
        when: () => true,
        message: 'Verify before stopping.',
      },
    ],
  };

  assert.deepEqual(
    await evaluateReminderHook(
      { hook_event_name: 'Stop', stop_hook_active: false },
      config,
    ),
    {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext:
          '[stop-feedback:verify-before-stop]\nVerify before stopping.',
      },
    },
  );
  assert.equal(
    await evaluateReminderHook(
      { hook_event_name: 'Stop', stop_hook_active: true },
      config,
    ),
    undefined,
  );
});

test('guards are only evaluated for PreToolUse', async () => {
  let evaluated = false;
  const output = await evaluateReminderHook(
    { hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
    {
      reminders: [],
      guards: [
        {
          id: 'tool-policy',
          when: () => {
            evaluated = true;
            return true;
          },
          deny: 'blocked',
        },
      ],
    },
  );

  assert.equal(evaluated, false);
  assert.equal(output, undefined);
});
