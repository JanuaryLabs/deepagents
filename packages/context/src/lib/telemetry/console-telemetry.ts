import type { Telemetry } from 'ai';

import { createTelemetryIntegration } from './create-telemetry-integration.ts';
import {
  createTelemetryLogRecord,
  stringifyTelemetryLogRecord,
} from './safe-serialize.ts';

/** Writing a telemetry record to the console logger failed; the observed operation goes on. */
class TelemetryLogWarning extends Error {
  readonly code = 'DEEPAGENTS_CONTEXT_TELEMETRY_LOG_FAILED';
  readonly detail: string;

  constructor(failure: unknown, event: string) {
    super(
      `Writing a telemetry record failed, and the observed operation goes on: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'TelemetryLogWarning';
    this.detail = `event: ${event}`;
  }
}

export interface ConsoleTelemetryOptions {
  pretty?: boolean;
  logger?: Pick<Console, 'log' | 'error'>;
  /** An entry gives `globalThis`; a test gives `createClock()`. */
  clock: { Date: { now(): number } };
}

export function createConsoleTelemetry(
  options: ConsoleTelemetryOptions,
): Telemetry {
  const logger = options.logger ?? console;
  const indentation = (options.pretty ?? true) ? 2 : undefined;
  const write = (method: 'log' | 'error', event: string, data: unknown) => {
    const record = createTelemetryLogRecord(
      options.clock.Date.now(),
      event,
      data,
    );
    try {
      logger[method](stringifyTelemetryLogRecord(record, indentation));
    } catch (error) {
      // Telemetry must never affect the observed operation.
      process.emitWarning(new TelemetryLogWarning(error, event));
    }
  };
  return createTelemetryIntegration(write);
}
