import { Lock } from '@zukhruf/async';
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
  /** An entry gives `globalThis`; a test gives `createClock()`. */
  clock: { Date: { now(): number } };
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
  const writes = new Lock();

  const write = (
    _level: 'log' | 'error',
    event: string,
    data: unknown,
  ): Promise<void> => {
    const record = createTelemetryLogRecord(
      options.clock.Date.now(),
      event,
      data,
    );
    const line = `${stringifyTelemetryLogRecord(record)}\n`;
    return writes
      .run(
        async () => {
          await initialize;
          await appendFile(path, line);
        },
        { signal: undefined },
      )
      .catch(reportWriteError);
  };

  return {
    ...createTelemetryIntegration(write),
    traces: { path: pathToFileURL(path).href },
  };
}
