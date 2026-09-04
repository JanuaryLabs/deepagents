import type { Telemetry } from 'ai';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createTelemetryIntegration } from '../create-telemetry-integration.ts';
import {
  createTelemetryLogRecord,
  stringifyTelemetryLogRecord,
} from '../safe-serialize.ts';

export interface FileTelemetryOptions {
  path: string;
  onWriteError?: (error: unknown) => void | PromiseLike<void>;
}

export function createFileTelemetry(
  options: FileTelemetryOptions,
): Telemetry & { readonly traces: { readonly path: string } } {
  const path = resolve(options.path);
  const reportWriteError = async (error: unknown): Promise<void> => {
    try {
      await options.onWriteError?.(error);
    } catch {
      // Telemetry must never affect the observed operation.
    }
  };
  const initialize = mkdir(dirname(path), { recursive: true }).then(
    () => undefined,
    reportWriteError,
  );
  let queue: Promise<void> = initialize;

  const write = (
    _level: 'log' | 'error',
    event: string,
    data: unknown,
  ): Promise<void> => {
    const record = createTelemetryLogRecord(event, data);
    const line = `${stringifyTelemetryLogRecord(record)}\n`;
    const pendingWrite = queue.then(async () => {
      await appendFile(path, line);
    });
    queue = pendingWrite.catch(() => {});
    return pendingWrite.catch(reportWriteError);
  };

  return {
    ...createTelemetryIntegration(write),
    traces: { path: pathToFileURL(path).href },
  };
}
