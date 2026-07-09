import type { HookPredicate } from '../types.ts';

export const envFlag =
  (name: string): HookPredicate =>
  () =>
    process.env[name] === '1' || process.env[name] === 'true';
