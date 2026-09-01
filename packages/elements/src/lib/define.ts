import { z } from 'zod';

import { elementSchema } from './schema.ts';
import { toDescriptor } from './serialize.ts';
import { type ElementDescriptor, findDuplicateName } from './types.ts';

/**
 * Validate a local element registry at definition time, so a bad descriptor
 * fails where it is written — not later inside a prompt or a render pass.
 * Extra host fields (e.g. a React `component`) pass through untouched; only
 * the descriptor projection is validated.
 */
export function defineElements<T extends ElementDescriptor>(
  elements: readonly T[],
): T[] {
  for (const element of elements) {
    const parsed = elementSchema.safeParse(toDescriptor(element));
    if (!parsed.success) {
      throw new Error(
        `Interactive element <${element.name}> is invalid:\n${z.prettifyError(parsed.error)}`,
      );
    }
  }
  const duplicate = findDuplicateName(elements);
  if (duplicate !== undefined) {
    throw new Error(
      `Duplicate element name <${duplicate}>: a catalog must map each tag to exactly one element.`,
    );
  }
  return [...elements];
}
