/**
 * ATIF v1.8, the Agent Trajectory Interchange Format, ported from Harbor's
 * Pydantic models (harbor-framework/harbor src/harbor/models/trajectories,
 * RFC 0001). Names, fields and optionality follow Harbor exactly; the two
 * divergences are unions that turn Harbor's runtime validators into types
 * (docs/ported-from-harbor-atif.md, ADR 0002).
 */

export const ATIF_SCHEMA_VERSION = 'ATIF-v1.8';

export type SchemaVersion =
  | 'ATIF-v1.0'
  | 'ATIF-v1.1'
  | 'ATIF-v1.2'
  | 'ATIF-v1.3'
  | 'ATIF-v1.4'
  | 'ATIF-v1.5'
  | 'ATIF-v1.6'
  | 'ATIF-v1.7'
  | 'ATIF-v1.8';

export type Extra = Record<string, unknown>;

export interface ImageSource {
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  path: string;
}

export interface AudioSource {
  media_type:
    | 'audio/wav'
    | 'audio/mpeg'
    | 'audio/mp4'
    | 'audio/aac'
    | 'audio/ogg'
    | 'audio/flac'
    | 'audio/webm'
    | 'audio/aiff';
  path: string;
  duration_sec?: number | null;
}

/** Harbor's `ContentPart`, whose `validate_content_type` becomes this union. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'audio'; source: AudioSource };

export interface ToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
  extra?: Extra | null;
}

export interface SubagentTrajectoryRef {
  trajectory_id?: string | null;
  session_id?: string | null;
  trajectory_path?: string | null;
  extra?: Extra | null;
}

export interface ObservationResult {
  /** A `tool_call_id` of the same step's `tool_calls` (Harbor's `validate_tool_call_references`). */
  source_call_id?: string | null;
  content?: string | ContentPart[] | null;
  subagent_trajectory_ref?: SubagentTrajectoryRef[] | null;
  extra?: Extra | null;
}

export interface Observation {
  results: ObservationResult[];
}

export interface Metrics {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cached_tokens?: number | null;
  cost_usd?: number | null;
  prompt_token_ids?: number[] | null;
  completion_token_ids?: number[] | null;
  logprobs?: number[] | null;
  extra?: Extra | null;
}

export interface FinalMetrics {
  total_prompt_tokens?: number | null;
  total_completion_tokens?: number | null;
  total_cached_tokens?: number | null;
  total_cost_usd?: number | null;
  total_steps?: number | null;
  extra?: Extra | null;
}

export interface Agent {
  name: string;
  version: string;
  model_name?: string | null;
  tool_definitions?: Record<string, unknown>[] | null;
  extra?: Extra | null;
}

interface StepBase {
  /** Sequential from 1 within one trajectory (Harbor's `validate_step_ids`). */
  step_id: number;
  /** ISO 8601. */
  timestamp?: string | null;
  message: string | ContentPart[];
  observation?: Observation | null;
  is_copied_context?: boolean | null;
  /** 0 on an agent step marks a deterministic dispatch with no model call. */
  llm_call_count?: number | null;
  extra?: Extra | null;
}

export interface UserStep extends StepBase {
  source: 'user';
}

export interface SystemStep extends StepBase {
  source: 'system';
}

/** The only step that may carry a model, reasoning, tool calls and metrics (Harbor's `validate_agent_only_fields`). */
export interface AgentStep extends StepBase {
  source: 'agent';
  model_name?: string | null;
  reasoning_effort?: string | number | null;
  reasoning_content?: string | null;
  tool_calls?: ToolCall[] | null;
  metrics?: Metrics | null;
}

export type Step = UserStep | AgentStep | SystemStep;

export interface Trajectory {
  schema_version: SchemaVersion;
  /** Run-scoped: segments of one run (a /clear chain, embedded subagents) may share it. */
  session_id?: string | null;
  /** Unique per document; required on every embedded subagent trajectory. */
  trajectory_id?: string | null;
  agent: Agent;
  /** At least one step. */
  steps: [Step, ...Step[]];
  notes?: string | null;
  final_metrics?: FinalMetrics | null;
  continued_trajectory_ref?: string | null;
  extra?: Extra | null;
  subagent_trajectories?: Trajectory[] | null;
}
