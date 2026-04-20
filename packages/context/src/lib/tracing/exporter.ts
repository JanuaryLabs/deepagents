import type { TracingExporter } from './processor.ts';
import type {
  FunctionSpanData,
  OpenAISpan,
  OpenAITrace,
  SpanData,
  TraceItem,
  TranscriptionSpanData,
} from './types.ts';

type StringifiedIOSpan = FunctionSpanData | TranscriptionSpanData;
type StringifiedIOSpanType = StringifiedIOSpan['type'];

const STRINGIFIED_IO_TYPES = {
  function: true,
  transcription: true,
} as const satisfies Record<StringifiedIOSpanType, true>;

type WireSpanData =
  | Exclude<SpanData, StringifiedIOSpan>
  | (Omit<StringifiedIOSpan, 'input' | 'output'> & {
      input?: string;
      output?: string;
    });

type WireSpan = Omit<OpenAISpan, 'span_data'> & { span_data: WireSpanData };
type WireTraceItem = OpenAITrace | WireSpan;

function hasStringifiedIO(data: SpanData): data is StringifiedIOSpan {
  return data.type in STRINGIFIED_IO_TYPES;
}

function encodeField(value: unknown): string | undefined {
  if (value == null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function toWireItem(item: TraceItem): WireTraceItem {
  if (item.object !== 'trace.span') return item;
  const spanData = item.span_data;
  if (!hasStringifiedIO(spanData)) {
    return { ...item, span_data: spanData };
  }
  return {
    ...item,
    span_data: {
      ...spanData,
      input: encodeField(spanData.input),
      output: encodeField(spanData.output),
    },
  };
}

export class OpenAIExportError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`OpenAI traces export failed (${status}): ${body}`);
    this.name = 'OpenAIExportError';
    this.status = status;
  }
}

export interface OpenAITracesExporterOptions {
  apiKey?: string | (() => string | Promise<string>);
  endpoint?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class OpenAITracesExporter implements TracingExporter {
  #apiKey: string | (() => string | Promise<string>);
  #endpoint: string;
  #organization?: string;
  #project?: string;
  #maxRetries: number;
  #baseDelayMs: number;
  #maxDelayMs: number;

  constructor(options: OpenAITracesExporterOptions = {}) {
    this.#apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.#endpoint =
      options.endpoint ??
      `${options.baseURL ?? 'https://api.openai.com'}/v1/traces/ingest`;
    this.#organization = options.organization;
    this.#project = options.project;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#baseDelayMs = options.baseDelayMs ?? 1000;
    this.#maxDelayMs = options.maxDelayMs ?? 30000;
  }

  async export(items: TraceItem[], signal?: AbortSignal): Promise<void> {
    if (items.length === 0) return;
    const apiKey = await this.#resolveApiKey();
    if (!apiKey) {
      throw new Error(
        'OpenAI API key is required. Set OPENAI_API_KEY or pass apiKey option.',
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'OpenAI-Beta': 'traces=v1',
    };
    if (this.#organization) {
      headers['OpenAI-Organization'] = this.#organization;
    }
    if (this.#project) {
      headers['OpenAI-Project'] = this.#project;
    }

    const body = JSON.stringify({ data: items.map(toWireItem) });
    await this.#fetchWithRetry(this.#endpoint, {
      method: 'POST',
      headers,
      body,
      signal,
    });
  }

  async #resolveApiKey(): Promise<string> {
    return typeof this.#apiKey === 'function'
      ? await this.#apiKey()
      : this.#apiKey;
  }

  async #fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.#maxRetries; attempt++) {
      try {
        const response = await fetch(url, init);
        if (response.ok) return response;
        if (response.status >= 400 && response.status < 500) {
          const text = await response.text().catch(() => '');
          throw new OpenAIExportError(response.status, text);
        }
        lastError = new Error(`Server error ${response.status}`);
      } catch (error) {
        if (error instanceof OpenAIExportError) {
          throw error;
        }
        lastError = error;
      }
      if (attempt < this.#maxRetries - 1) {
        const delay = Math.min(
          this.#baseDelayMs * 2 ** attempt,
          this.#maxDelayMs,
        );
        const jitter = delay * (0.9 + Math.random() * 0.2);
        await new Promise((r) => setTimeout(r, jitter));
      }
    }
    throw lastError;
  }
}
