import type { ContextFragment } from '../fragments.ts';
import { role } from './domain.ts';
import { SOCRATIC_ROLE, socraticInquiry } from './socratic-inquiry.ts';

/**
 * Socratic prompting framework.
 *
 * Teaches an LLM to investigate substantive work through adaptive questions,
 * apply the answers to the specific case, and execute from that synthesis.
 *
 * @see https://en.wikipedia.org/wiki/Socratic_method
 *
 * @example
 * ```ts
 * import { socraticPrompting } from '@deepagents/context';
 *
 * context.set(...socraticPrompting());
 * ```
 */
export function socraticPrompting(): ContextFragment[] {
  return [role(SOCRATIC_ROLE), socraticInquiry()];
}
