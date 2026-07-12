const REDACTED = '[Redacted]';

const INPUT_FIELDS = [
  'system',
  'prompt',
  'instructions',
  'messages',
  'tools',
  'toolChoice',
  'activeTools',
  'toolOrder',
  'headers',
  'providerOptions',
  'runtimeContext',
  'toolsContext',
  'toolContext',
  'promptMessages',
  'stepTools',
  'stepToolChoice',
  'request',
  'values',
  'value',
  'query',
  'documents',
  'schema',
  'schemaDescription',
  'schemaName',
] as const;

const OUTPUT_FIELDS = [
  'content',
  'text',
  'reasoning',
  'reasoningText',
  'files',
  'sources',
  'toolCalls',
  'staticToolCalls',
  'dynamicToolCalls',
  'toolResults',
  'staticToolResults',
  'dynamicToolResults',
  'response',
  'responseMessages',
  'providerMetadata',
  'steps',
  'finalStep',
  'object',
  'objectText',
  'embedding',
  'embeddings',
  'ranking',
  'rankings',
  'results',
  'error',
] as const;

const OUTPUT_SPECIFICATION_EVENTS = new Set([
  'onStart',
  'onStepStart',
  'onObjectStepStart',
]);

export function redactTelemetryEvent(event: string, data: unknown): unknown {
  if (!isRecord(data)) return data;
  const recordInputs = data.recordInputs !== false;
  const recordOutputs = data.recordOutputs !== false;
  if (recordInputs && recordOutputs) return data;

  const redacted = { ...data };
  if (!recordInputs) {
    redactFields(redacted, INPUT_FIELDS);
    if (
      OUTPUT_SPECIFICATION_EVENTS.has(event) &&
      Object.hasOwn(redacted, 'output')
    ) {
      redacted.output = REDACTED;
    }
    if (Object.hasOwn(redacted, 'toolCall')) {
      redacted.toolCall = redactToolCallInput(redacted.toolCall);
    }
    if (Object.hasOwn(redacted, 'toolOutput')) {
      redacted.toolOutput = redactToolOutput(redacted.toolOutput, true, false);
    }
    if (Object.hasOwn(redacted, 'steps')) {
      redacted.steps = redactStepInputs(redacted.steps);
    }
    if (Object.hasOwn(redacted, 'finalStep')) {
      redacted.finalStep = redactStepInputs(redacted.finalStep);
    }
  }
  if (!recordOutputs) {
    redactFields(redacted, OUTPUT_FIELDS);
    if (
      !OUTPUT_SPECIFICATION_EVENTS.has(event) &&
      Object.hasOwn(redacted, 'output')
    ) {
      redacted.output = REDACTED;
    }
    if (Object.hasOwn(redacted, 'toolOutput')) {
      redacted.toolOutput = redactToolOutput(redacted.toolOutput, false, true);
    }
  }
  return redacted;
}

function redactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (Object.hasOwn(value, field)) value[field] = REDACTED;
  }
}

function redactToolCallInput(value: unknown): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, 'input')) return value;
  return { ...value, input: REDACTED };
}

function redactToolOutput(
  value: unknown,
  redactInput: boolean,
  redactOutput: boolean,
): unknown {
  if (!isRecord(value)) return value;
  const redacted = { ...value };
  if (redactInput && Object.hasOwn(redacted, 'input')) {
    redacted.input = REDACTED;
  }
  if (redactOutput) {
    if (Object.hasOwn(redacted, 'output')) redacted.output = REDACTED;
    if (Object.hasOwn(redacted, 'error')) redacted.error = REDACTED;
  }
  return redacted;
}

function redactStepInputs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStepInputs);
  if (!isRecord(value)) return value;
  const redacted = { ...value };
  redactFields(redacted, INPUT_FIELDS);
  return redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
