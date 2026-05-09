import { appendFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { v7 } from 'uuid';

import { type ContextFragment, fragment } from '@deepagents/context';

import type { Text2SqlIndexProgressEvent } from '../../lib/adapter-index.ts';
import type {
  Adapter,
  IntrospectionProgress,
} from '../../lib/adapters/adapter.ts';
import { createGroundingContext } from '../../lib/adapters/groundings/context.ts';
import {
  type CommandResult,
  type ExecutionContext,
  SqlCommand,
  errorMessage,
} from '../command.ts';

interface IndexManifest {
  fragmentsPath: string;
  eventsPath: string;
  adapters: string[];
  fragments: number;
}

export class IndexCommand extends SqlCommand {
  readonly name = 'index';
  readonly description = 'Index adapter schemas and write context artifacts';
  readonly args = '[...adapters]';
  readonly usage = '[--all] [adapter ...]';
  override readonly helpDisplay = '[--all] [adapter ...]';
  override readonly options = [
    { flag: '--all', description: 'Index all adapters (default)' },
  ];

  async execute(
    ctx: ExecutionContext,
    args: unknown[],
    options: Record<string, unknown>,
  ): Promise<CommandResult> {
    const adapterNames = (args[0] as string[] | undefined) ?? [];
    const requested = options.all ? [] : adapterNames;
    const entries = this.resolveEntries(ctx.adapters, requested);

    const outputDir = path.resolve(ctx.cwd, './sql');
    const id = v7();
    const fragmentsPath = path.join(outputDir, `index-${id}.json`);
    const eventsPath = path.join(outputDir, `index-${id}.events.ndjson`);

    try {
      await mkdir(outputDir, { recursive: true });
      await writeFile(eventsPath, '');

      const fragments = await this.indexAll(entries, (event) => {
        appendProgressEvent(eventsPath, event);
      });

      await writeFile(fragmentsPath, JSON.stringify(fragments, null, 2));

      const manifest: IndexManifest = {
        fragmentsPath,
        eventsPath,
        adapters: entries.map(([name]) => name),
        fragments: countSchemaFragments(fragments),
      };

      return {
        stdout: JSON.stringify(manifest, null, 2) + '\n',
        stderr: '',
        exitCode: 0,
      };
    } catch (error) {
      this.fail(errorMessage(error));
    }
  }

  private resolveEntries(
    adapters: Record<string, Adapter>,
    requested: string[],
  ): Array<[string, Adapter]> {
    const availableNames = Object.keys(adapters);
    const available = availableNames.join(', ') || '(none configured)';
    const names = requested.length === 0 ? availableNames : dedupe(requested);

    for (const name of names) {
      if (!adapters[name]) {
        this.fail(`unknown adapter "${name}". Available: ${available}`);
      }
    }
    return names.map((name) => [name, adapters[name]]);
  }

  private async indexAll(
    entries: Array<[string, Adapter]>,
    onProgress: (event: Text2SqlIndexProgressEvent) => void,
  ): Promise<ContextFragment[]> {
    onProgress({
      type: 'index:start',
      message: `Indexing ${entries.length} adapter${entries.length === 1 ? '' : 's'}...`,
      current: 0,
      total: entries.length,
    });

    const settled = await Promise.allSettled(
      entries.map(async ([name, adapter]) => {
        const schema = await indexAdapter(name, adapter, onProgress);
        return fragment(name, ...schema);
      }),
    );

    const failed = settled.find((result) => result.status === 'rejected');
    if (failed) {
      onProgress({
        type: 'index:error',
        message: errorMessage(failed.reason),
      });
      throw failed.reason;
    }

    const fragments = settled.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });

    onProgress({
      type: 'index:end',
      message: 'Finished indexing adapters.',
      current: entries.length,
      total: entries.length,
    });

    return fragments;
  }
}

async function indexAdapter(
  name: string,
  adapter: Adapter,
  onProgress: (event: Text2SqlIndexProgressEvent) => void,
): Promise<ContextFragment[]> {
  onProgress({
    type: 'adapter:start',
    adapter: name,
    message: `Indexing adapter "${name}"...`,
  });

  try {
    const ctx = createGroundingContext({
      onProgress: (event) => onProgress(adapterProgressEvent(name, event)),
    });
    const fragments = await adapter.introspect(ctx);
    onProgress({
      type: 'adapter:end',
      adapter: name,
      message: `Finished indexing adapter "${name}".`,
      cached: false,
    });
    return fragments;
  } catch (error) {
    const reason = errorMessage(error);
    onProgress({
      type: 'adapter:error',
      adapter: name,
      message: `Failed indexing adapter "${name}": ${reason}`,
    });
    throw new Error(`introspecting adapter "${name}": ${reason}`, {
      cause: error,
    });
  }
}

function adapterProgressEvent(
  adapter: string,
  progress: IntrospectionProgress,
): Text2SqlIndexProgressEvent {
  return {
    type: progress.type,
    adapter,
    phase: progress.phase,
    table: progress.table,
    message: progress.message,
    current: progress.current,
    total: progress.total,
    cached: false,
    timestampMs: progress.timestampMs,
  };
}

function appendProgressEvent(
  eventsPath: string,
  event: Text2SqlIndexProgressEvent,
): void {
  appendFileSync(
    eventsPath,
    JSON.stringify({
      ...event,
      timestampMs: event.timestampMs ?? Date.now(),
    }) + '\n',
  );
}

function countSchemaFragments(fragments: ContextFragment[]): number {
  return fragments.reduce((count, adapterFragment) => {
    if (Array.isArray(adapterFragment.data)) {
      return count + adapterFragment.data.length;
    }
    return count + 1;
  }, 0);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
