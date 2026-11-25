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

/** A telemetry file's onWriteError threw or rejected; the observed operation goes on. */
class TelemetryWriteHandlerWarning extends Error {
  readonly code = 'DEEPAGENTS_CONTEXT_TELEMETRY_WRITE_HANDLER_FAILED';
  readonly detail: string;

  constructor(failure: unknown, path: string) {
    super(
      `The onWriteError of a telemetry file failed, and the observed operation goes on: ${Error.isError(failure) ? failure.message : String(failure)}`,
      { cause: failure },
    );
    this.name = 'TelemetryWriteHandlerWarning';
    this.detail = `path: ${path}`;
  }
}

export function createFileTelemetry(
  options: FileTelemetryOptions,
): Telemetry & { readonly traces: { readonly path: string } } {
  const path = resolve(options.path);
  const reportWriteError = async (error: unknown): Promise<void> => {
    try {
      await options.onWriteError?.(error);
    } catch (failure) {
      // Telemetry must never affect the observed operation.
      process.emitWarning(new TelemetryWriteHandlerWarning(failure, path));
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
