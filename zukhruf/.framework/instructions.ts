import { type ContextFragment, role } from '@deepagents/context';

export function defineInstructions(...fragments: ContextFragment[]) {
  return fragments;
}
