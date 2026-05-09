import { appendFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { v7 } from 'uuid';

import type { ContextFragment } from '@deepagents/context';

import {
  AdapterIndexer,
  type Text2SqlIndexProgressEvent,
} from '../../lib/adapter-index.ts';
import type { Adapter } from '../../lib/adapters/adapter.ts';
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
    const names = this.resolveNames(ctx.adapters, requested);

    const outputDir = path.resolve(ctx.cwd, './sql');
    const id = v7();
    const fragmentsPath = path.join(outputDir, `index-${id}.json`);
    const eventsPath = path.join(outputDir, `index-${id}.events.ndjson`);

    try {
      await mkdir(outputDir, { recursive: true });
      await writeFile(eventsPath, '');

      const indexer = new AdapterIndexer({ adapters: ctx.adapters });
      const fragments = await indexer.index({
        adapterNames: names,
        onProgress: (event) => appendProgressEvent(eventsPath, event),
      });

      await writeFile(fragmentsPath, JSON.stringify(fragments, null, 2));

      const manifest: IndexManifest = {
        fragmentsPath,
        eventsPath,
        adapters: names,
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

  private resolveNames(
    adapters: Record<string, Adapter>,
    requested: string[],
  ): string[] {
    const availableNames = Object.keys(adapters);
    const available = availableNames.join(', ') || '(none configured)';
    const names = requested.length === 0 ? availableNames : dedupe(requested);

    for (const name of names) {
      if (!adapters[name]) {
        this.fail(`unknown adapter "${name}". Available: ${available}`);
      }
    }
    return names;
  }
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
