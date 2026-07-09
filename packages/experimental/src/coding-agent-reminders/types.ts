export type HookEventName =
  | 'SessionStart'
  | 'Setup'
  | 'SubagentStart'
  | 'UserPromptSubmit'
  | 'UserPromptExpansion'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch'
  | 'Stop'
  | 'SubagentStop';

export type ClaudeBatchToolCall = {
  tool_name: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
};

export type ClaudeHookInput = {
  hook_event_name: HookEventName | string;
  session_id?: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  prompt?: string;
  command_name?: string;
  command_args?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: unknown;
  tool_response?: unknown;
  tool_calls?: ClaudeBatchToolCall[];
  source?: string;
  trigger?: string;
  agent_type?: string;
  stop_hook_active?: boolean;
  [key: string]: unknown;
};

export type HookPredicate = (
  ctx: ClaudeHookInput,
) => boolean | Promise<boolean>;

export type AsyncHookPredicate = (ctx: ClaudeHookInput) => Promise<boolean>;

export type ReminderTarget =
  | 'session'
  | 'prompt'
  | 'tool-result'
  | 'tool-batch'
  | 'stop-feedback';

export type ReminderRule = {
  id: string;
  target: ReminderTarget;
  events: HookEventName[];
  when: HookPredicate;
  message: string | ((ctx: ClaudeHookInput) => string);
};

export type GuardRule = {
  id: string;
  when: HookPredicate;
  deny: string | ((ctx: ClaudeHookInput) => string);
};

export type ClaudeHookOutput = {
  decision?: 'block';
  reason?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    permissionDecision?: 'allow' | 'deny' | 'ask' | 'defer';
    permissionDecisionReason?: string;
  };
};

export type ReminderHookConfig = {
  reminders: ReminderRule[];
  guards: GuardRule[];
};

export type CountSpec = { gte?: number; lte?: number; eq?: number };

export type ToolNameSpec = string | ((name: string) => boolean);

export type ToolCallState =
  | 'input-available'
  | 'output-available'
  | 'output-error';

export type ToolCallOptions = {
  name?: ToolNameSpec;
  state?: ToolCallState;
  input?: (input: unknown) => boolean;
  output?: (output: unknown) => boolean;
  errorText?: (text: string) => boolean;
};

export interface ClassifierMatch<T> {
  item: T;
  score: number;
}

export interface ClassifierOptions {
  topN?: number;
  threshold?: number;
}

export interface IClassifier<T> {
  match(query: string, options?: ClassifierOptions): ClassifierMatch<T>[];
}

export interface ContentMatchesOptions {
  threshold?: number;
}
