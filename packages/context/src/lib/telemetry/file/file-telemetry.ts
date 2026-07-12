import type { Telemetry } from 'ai';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createTelemetryIntegration } from '../create-telemetry-integration.ts';
import {
  createTelemetryLogRecord,
  stringifyTelemetryLogRecord,
} from '../safe-serialize.ts';

export interface FileTelemetryOptions {
  path: string;
  includeTimestamp?: boolean;
  append?: boolean;
  onWriteError?: (error: unknown) => void | PromiseLike<void>;
}

export function createFileTelemetry(options: FileTelemetryOptions): Telemetry {
  const includeTimestamp = options.includeTimestamp ?? true;
  const reportWriteError = async (error: unknown): Promise<void> => {
    try {
      await options.onWriteError?.(error);
    } catch {
      // Telemetry must never affect the observed operation.
    }
  };
  const initialize = mkdir(dirname(options.path), { recursive: true })
    .then(async () => {
      if (options.append === false) await writeFile(options.path, '');
    })
    .catch(reportWriteError);
  let queue: Promise<void> = initialize;

  const write = (
    _level: 'log' | 'error',
    event: string,
    data: unknown,
  ): Promise<void> => {
    const record = createTelemetryLogRecord(event, data, includeTimestamp);
    const line = `${stringifyTelemetryLogRecord(record)}\n`;
    const pendingWrite = queue.then(async () => {
      await appendFile(options.path, line);
    });
    queue = pendingWrite.catch(() => {});
    return pendingWrite.catch(reportWriteError);
  };

  return createTelemetryIntegration(write);
}
