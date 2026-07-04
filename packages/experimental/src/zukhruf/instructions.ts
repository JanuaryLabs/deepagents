import type { ContextFragment } from '@deepagents/context';

export function defineInstructions(...fragments: ContextFragment[]) {
  return fragments;
}
