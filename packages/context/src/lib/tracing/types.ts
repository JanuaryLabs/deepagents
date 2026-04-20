export interface OpenAITrace {
  object: 'trace';
  id: string;
  workflow_name: string;
  group_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface OpenAISpan {
  object: 'trace.span';
  id: string;
  trace_id: string;
  parent_id?: string | null;
  started_at: string;
  ended_at?: string | null;
  span_data: SpanData;
  error?: OpenAISpanError | null;
}

export type SpanData =
  | GenerationSpanData
  | FunctionSpanData
  | AgentSpanData
  | HandoffSpanData
  | GuardrailSpanData
  | CustomSpanData
  | ResponseSpanData
  | MCPListToolsSpanData
  | SpeechSpanData
  | SpeechGroupSpanData
  | TranscriptionSpanData;

export interface OpenAISpanError {
  message: string;
  data?: Record<string, unknown>;
}

export interface GenerationUsageData {
  input_tokens?: number;
  output_tokens?: number;
  details?: Record<string, unknown>;
}

export interface GenerationSpanData {
  type: 'generation';
  input?: Record<string, unknown>[];
  output?: Record<string, unknown>[];
  model?: string;
  model_config?: Record<string, unknown>;
  usage?: GenerationUsageData;
}

export interface FunctionSpanData {
  type: 'function';
  name: string;
  input?: unknown;
  output?: unknown;
}

export interface AgentSpanData {
  type: 'agent';
  name: string;
  tools?: string[];
  output_type?: string;
}

export interface HandoffSpanData {
  type: 'handoff';
  from_agent: string;
  to_agent: string;
}

export interface GuardrailSpanData {
  type: 'guardrail';
  name: string;
  triggered: boolean;
}

export interface CustomSpanData {
  type: 'custom';
  name: string;
  data?: Record<string, unknown>;
}

export interface ResponseSpanData {
  type: 'response';
  response_id?: string;
}

export interface MCPListToolsSpanData {
  type: 'mcp_list_tools';
  server?: string;
  result?: Record<string, unknown>;
}

export interface SpeechSpanData {
  type: 'speech';
  model?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export interface SpeechGroupSpanData {
  type: 'speech_group';
  name: string;
}

export interface TranscriptionSpanData {
  type: 'transcription';
  model?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export type TraceItem = OpenAITrace | OpenAISpan;
