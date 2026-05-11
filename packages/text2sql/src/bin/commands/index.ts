import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { finished } from 'node:stream/promises';
import { v7 } from 'uuid';

import type { ContextFragment } from '@deepagents/context';

import {
  AdapterIndexer,
  type Text2SqlIndexProgressHandler,
} from '../../lib/adapter-index.ts';
import type { Adapter } from '../../lib/adapters/adapter.ts';
import {
  type ExecutionContext,
  OUT_DIR_OPTION,
  SqlCommand,
  errorMessage,
  resolveOutputDir,
} from '../command.ts';
import { type VerboseFormat, formatPretty } from './indexing-formatter.ts';

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
  readonly usage = '[--all] [--verbose [pretty|json]] [adapter ...]';
  override readonly helpDisplay = '[--all] [--verbose] [adapter ...]';
  override readonly options = [
    { flag: '--all', description: 'Index all adapters (default)' },
    {
      flag: '-v, --verbose [format]',
      description:
        'Mirror progress events to stderr (format: pretty (default) | json)',
    },
    OUT_DIR_OPTION,
  ];

  async execute(
    ctx: ExecutionContext,
    args: unknown[],
    options: Record<string, unknown>,
  ): Promise<number> {
    const adapterNames = (args[0] as string[] | undefined) ?? [];
    const requested = options.all ? [] : adapterNames;
    const names = this.resolveNames(ctx.adapters, requested);
    const verbose = this.resolveVerbose(options.verbose);

    const outputDir = resolveOutputDir(ctx, options);
    const id = v7();
    const fragmentsPath = path.join(outputDir, `index-${id}.json`);
    const eventsPath = path.join(outputDir, `index-${id}.events.ndjson`);

    try {
      await mkdir(outputDir, { recursive: true });
      const eventsStream = createWriteStream(eventsPath, {
        flags: 'a',
        encoding: 'utf-8',
      });
      try {
        const indexer = new AdapterIndexer({
          adapters: ctx.adapters,
          version: ctx.env.TEXT2SQL_INDEX_VERSION,
        });
        const fragments = await indexer.index({
          adapterNames: names,
          onProgress: createProgressHandler(eventsStream, verbose, ctx.stderr),
        });

        await writeFile(fragmentsPath, JSON.stringify(fragments, null, 2));

        const manifest: IndexManifest = {
          fragmentsPath,
          eventsPath,
          adapters: names,
          fragments: countSchemaFragments(fragments),
        };

        ctx.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
        return 0;
      } finally {
        eventsStream.end();
        await finished(eventsStream).catch(() => {});
      }
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

  private resolveVerbose(value: unknown): VerboseFormat | null {
    if (value === undefined || value === false) return null;
    if (value === true || value === '' || value === 'pretty') return 'pretty';
    if (value === 'json') return 'json';
    this.fail(
      `invalid --verbose value "${String(value)}". Expected "pretty" or "json".`,
    );
  }
}

function createProgressHandler(
  eventsStream: NodeJS.WritableStream,
  verbose: VerboseFormat | null,
  stderr: NodeJS.WritableStream,
): Text2SqlIndexProgressHandler {
  return (event) => {
    const stamped = { ...event, timestampMs: event.timestampMs ?? Date.now() };
    const json = JSON.stringify(stamped) + '\n';
    eventsStream.write(json);
    if (verbose === 'pretty') stderr.write(formatPretty(stamped) + '\n');
    else if (verbose === 'json') stderr.write(json);
  };
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
