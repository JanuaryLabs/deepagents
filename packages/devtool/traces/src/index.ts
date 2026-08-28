import type { Telemetry } from 'ai';

import {
  type FileTelemetryOptions,
  createFileTelemetry,
} from '@deepagents/context/telemetry/file';
import {
  type AgentPluginDefinition,
  type AgentPluginInstance,
  type AgentPluginToolContext,
} from '@deepagents/experimental/zukhruf';

import { FileTraceAdapter } from './file-trace-adapter.ts';
import type { AgentTraceReader } from './file-trace-adapter.ts';

export * from './file-trace-adapter.ts';

export interface FileTelemetryInstance {
  readonly traces: AgentTraceReader;
}

/** File telemetry integration with transport-neutral trace reads. */
export function fileTelemetry(
  options: FileTelemetryOptions,
): AgentPluginDefinition<FileTelemetryInstance> {
  const integration = createFileTelemetry(options);
  return {
    name: `file-telemetry:${integration.traces.path}`,
    create: () => new FileTelemetryPlugin(integration),
  };
}

class FileTelemetryPlugin
  implements AgentPluginInstance, FileTelemetryInstance
{
  readonly #integration: ReturnType<typeof createFileTelemetry>;
  readonly traces: AgentTraceReader;

  constructor(integration: ReturnType<typeof createFileTelemetry>) {
    this.#integration = integration;
    this.traces = new FileTraceAdapter(new URL(integration.traces.path));
  }

  telemetry(context: AgentPluginToolContext): Telemetry {
    const integration = this.#integration;
    return {
      ...integration,
      onStart: (event) =>
        integration.onStart?.call(integration, { ...event, zukhruf: context }),
    };
  }
}
