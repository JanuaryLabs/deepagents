# Coding Agent Reminders

This experimental subpath provides an event-aware reminder and guard framework
for Claude Code hooks. Applications supply their own rules and decide which
hook events to wire. The evaluator emits either:

- `hookSpecificOutput.additionalContext` for model-visible reminders
- `hookSpecificOutput.permissionDecision: "deny"` for deterministic tool policy

## Files

- `index.ts` - public `@deepagents/experimental/coding-agent-reminders` surface
- `types.ts` - hook input/output, rule, predicate, classifier, and count types
- `context.ts` - normalization helpers for Claude prompt, tool, and output payloads
- `evaluate.ts` - generic guard/reminder evaluation and output construction
- `io.ts` - stdin/stdout helpers for command hooks
- `predicates/` - ported DeepAgents-style predicate families
- `reminders.test.ts` - focused Node test coverage for the predicate layer

## Ported Predicate Surface

The predicate names intentionally mirror DeepAgents where the Claude hook event
model has an equivalent:

- combinators: `and`, `or`, `not`
- content: `contentIncludes`, `contentPattern`, `contentMatches`, `classifies`
- classifier: `BM25Classifier`
- tool: `toolCall`, `toolCalled`, `toolFailed`, `anyToolCalled`, `toolCallCount`
- counters: `CountSpec`, `checkCount`, `assertCountSpec`

Claude hooks do not provide DeepAgents chain history, turn counters, elapsed
time, or model usage by default. Predicates that depend on those values are not
part of this raw-hook API; applications need an explicit state enrichment layer
before adding them.

## DeepAgents Target Mapping

| DeepAgents target        | Hook target in this file | Claude events                             |
| ------------------------ | ------------------------ | ----------------------------------------- |
| `user`                   | `prompt`                 | `UserPromptSubmit`, `UserPromptExpansion` |
| `user` session context   | `session`                | `SessionStart`, `Setup`, `SubagentStart`  |
| `tool-output`            | `tool-result`            | `PostToolUse`, `PostToolUseFailure`       |
| `steer` after tool loop  | `tool-batch`             | `PostToolBatch`                           |
| `steer` before finishing | `stop-feedback`          | `Stop`, `SubagentStop`                    |
| guard, not reminder      | guard rule               | `PreToolUse`                              |

This table maps equivalent lifecycle moments, not wire formats. In
`@deepagents/context`, `tool-output` predicates receive a terminal
`ToolOutcome` (`output-available`, `output-error`, or `output-denied`) at the
AI SDK `prepareStep` boundary. Claude hooks expose success and failure as
separate post-tool events and return `additionalContext` through Claude's hook
protocol.

Guards are evaluated only for `PreToolUse` and fail closed if their predicate
throws. Stop feedback is suppressed when `stop_hook_active` is true so a hook
cannot continue its own continuation repeatedly. `PostToolBatch` predicates
inspect every entry in Claude's `tool_calls` array.

## Usage

```ts
import {
  type ReminderHookConfig,
  contentPattern,
  evaluateReminderHook,
} from '@deepagents/experimental/coding-agent-reminders';

const config: ReminderHookConfig = {
  guards: [],
  reminders: [
    {
      id: 'reproduce-failures',
      target: 'prompt',
      events: ['UserPromptSubmit'],
      when: contentPattern(/\b(fix|failure|debug)\b/i),
      message: 'Reproduce the failure before changing code.',
    },
  ],
};

const output = await evaluateReminderHook(input, config);
```
