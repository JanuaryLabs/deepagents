import type { Telemetry } from 'ai';

import { createTelemetryIntegration } from './create-telemetry-integration.ts';
import {
  createTelemetryLogRecord,
  stringifyTelemetryLogRecord,
} from './safe-serialize.ts';

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
    } catch {
      // Telemetry must never affect the observed operation.
    }
  };
  return createTelemetryIntegration(write);
}
