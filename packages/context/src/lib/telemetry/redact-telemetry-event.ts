import { isRecord } from '@ai-sdk/provider-utils';

const REDACTED = '[Redacted]';

/**
 * Hides the headers that the AI SDK still hands every integration when
 * `recordInputs` or `recordOutputs` is false. The SDK's own filter
 * (`filterTelemetryEvent`) already empties prompts, tool inputs and outputs,
 * model output, schemas and provider options, and its context allow-lists
 * drop the runtime and tool context a host did not include. It keeps the
 * call's `headers` (an `authorization` header, for one) and each model
 * response's `headers` (`set-cookie`, for one).
 */
export function redactTelemetryEvent(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const hideInputs = data.recordInputs === false;
  const hideOutputs = data.recordOutputs === false;
  if (!hideInputs && !hideOutputs) return data;

  const redacted = { ...data };
  if (hideInputs && Object.hasOwn(redacted, 'headers')) {
    redacted.headers = REDACTED;
  }
  if (hideOutputs) {
    if (Object.hasOwn(redacted, 'response')) {
      redacted.response = redactHeadersOf(redacted.response);
    }
    if (Array.isArray(redacted.steps)) {
      redacted.steps = redacted.steps.map(redactResponseHeadersOf);
    }
    if (Object.hasOwn(redacted, 'finalStep')) {
      redacted.finalStep = redactResponseHeadersOf(redacted.finalStep);
    }
  }
  return redacted;
}

function redactHeadersOf(response: unknown): unknown {
  if (!isRecord(response) || !Object.hasOwn(response, 'headers')) {
    return response;
  }
  return { ...response, headers: REDACTED };
}

function redactResponseHeadersOf(step: unknown): unknown {
  if (!isRecord(step) || !Object.hasOwn(step, 'response')) return step;
  return { ...step, response: redactHeadersOf(step.response) };
}
