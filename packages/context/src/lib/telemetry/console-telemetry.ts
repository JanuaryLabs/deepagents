import type { Telemetry } from 'ai';

import { createTelemetryIntegration } from './create-telemetry-integration.ts';
import {
  createTelemetryLogRecord,
  stringifyTelemetryLogRecord,
} from './safe-serialize.ts';

export interface ConsoleTelemetryOptions {
  includeTimestamp?: boolean;
  pretty?: boolean;
  logger?: Pick<Console, 'log' | 'error'>;
}

export function createConsoleTelemetry(
  options: ConsoleTelemetryOptions = {},
): Telemetry {
  const logger = options.logger ?? console;
  const includeTimestamp = options.includeTimestamp ?? true;
  const indentation = (options.pretty ?? true) ? 2 : undefined;
  const write = (method: 'log' | 'error', event: string, data: unknown) => {
    const record = createTelemetryLogRecord(event, data, includeTimestamp);
    try {
      logger[method](stringifyTelemetryLogRecord(record, indentation));
    } catch {
      // Telemetry must never affect the observed operation.
    }
  };
  return createTelemetryIntegration(write);
}
