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

  let mod: { default?: unknown };
  try {
    mod = (await import(specifier)) as { default?: unknown };
  } catch (cause) {
    throw new Error(
      `TEXT2SQL_ADAPTERS=${target}: failed to import module - ${errorMessage(cause)}`,
    );
  }

  const exported = mod.default;
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

  for (const [name, value] of entries) {
    if (!isAdapterShape(value)) {
      throw new Error(
        `TEXT2SQL_ADAPTERS=${target}: adapter "${name}" is missing one of the required methods (format, validate, execute).`,
      );
    }
  }

  try {
    validateAdapterNames(entries.map(([name]) => name));
  } catch (cause) {
    throw new Error(`TEXT2SQL_ADAPTERS=${target}: ${errorMessage(cause)}`);
  }

  return exported as Record<string, Adapter>;
}

function isAdapterShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.format === 'function' &&
    typeof v.validate === 'function' &&
    typeof v.execute === 'function'
  );
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
