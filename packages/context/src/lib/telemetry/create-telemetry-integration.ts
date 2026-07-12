import type { Telemetry } from 'ai';

import { redactTelemetryEvent } from './redact-telemetry-event.ts';

type TelemetryLogLevel = 'log' | 'error';

type TelemetryEventWriter = (
  level: TelemetryLogLevel,
  event: string,
  data: unknown,
) => void | PromiseLike<void>;

export function createTelemetryIntegration(
  write: TelemetryEventWriter,
): Telemetry {
  const emit = (level: TelemetryLogLevel, event: string, data: unknown) =>
    write(level, event, redactTelemetryEvent(event, data));
  const log = (event: string, data: unknown) => emit('log', event, data);

  return {
    onStart: (event) => log('onStart', event),
    onStepStart: (event) => log('onStepStart', event),
    onLanguageModelCallStart: (event) => log('onLanguageModelCallStart', event),
    onLanguageModelCallEnd: (event) => log('onLanguageModelCallEnd', event),
    onToolExecutionStart: (event) => log('onToolExecutionStart', event),
    onToolExecutionEnd: (event) => log('onToolExecutionEnd', event),
    onStepEnd: (event) => log('onStepEnd', event),
    onObjectStepStart: (event) => log('onObjectStepStart', event),
    onObjectStepEnd: (event) => log('onObjectStepEnd', event),
    onEmbedStart: (event) => log('onEmbedStart', event),
    onEmbedEnd: (event) => log('onEmbedEnd', event),
    onRerankStart: (event) => log('onRerankStart', event),
    onRerankEnd: (event) => log('onRerankEnd', event),
    onEnd: (event) => log('onEnd', event),
    onAbort: (event) => log('onAbort', event),
    onError: (error) => emit('error', 'onError', error),
  };
}
