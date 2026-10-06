import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateAdapterNames } from '../lib/adapter-name.ts';
import type { Adapter } from '../lib/adapters/adapter.ts';
import { errorMessage } from './command.ts';

export async function loadAdapters(): Promise<Record<string, Adapter>> {
  const target = process.env.TEXT2SQL_ADAPTERS;
  if (!target) {
    throw new Error(
      'TEXT2SQL_ADAPTERS env var is not set. Point it at a module whose default export is Record<string, Adapter>.',
    );
  }

  const specifier =
    target.startsWith('.') || target.startsWith('/')
      ? pathToFileURL(resolve(target)).href
      : target;

  const mod: unknown = await import(specifier).catch((cause: unknown) => {
    throw new Error(
      `TEXT2SQL_ADAPTERS=${target}: failed to import module - ${errorMessage(cause)}`,
    );
  });

  const exported =
    typeof mod === 'object' && mod !== null && 'default' in mod
      ? mod.default
      : undefined;
  if (!exported || typeof exported !== 'object' || Array.isArray(exported)) {
    throw new Error(
      `TEXT2SQL_ADAPTERS=${target}: default export must be a Record<string, Adapter> (got ${describe(exported)}).`,
    );
  }

  const entries = Object.entries(exported);
  if (entries.length === 0) {
    throw new Error(
      `TEXT2SQL_ADAPTERS=${target}: default export is an empty object - declare at least one adapter.`,
    );
  }

  const adapters: Record<string, Adapter> = {};
  for (const [name, value] of entries) {
    if (!isAdapterShape(value)) {
      throw new Error(
        `TEXT2SQL_ADAPTERS=${target}: adapter "${name}" is missing one of the required methods (format, validate, execute).`,
      );
    }
    adapters[name] = value;
  }

  try {
    validateAdapterNames(entries.map(([name]) => name));
  } catch (cause) {
    throw new Error(`TEXT2SQL_ADAPTERS=${target}: ${errorMessage(cause)}`);
  }

  return adapters;
}

/**
 * The CLI accepts any object with the methods every command calls, so a
 * module may export plain objects as well as Adapter instances. Indexing also
 * calls introspect(), which fails when an adapter does not provide it.
 */
function isAdapterShape(value: unknown): value is Adapter {
  return (
    typeof value === 'object' &&
    value !== null &&
    'format' in value &&
    typeof value.format === 'function' &&
    'validate' in value &&
    typeof value.validate === 'function' &&
    'execute' in value &&
    typeof value.execute === 'function'
  );
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
