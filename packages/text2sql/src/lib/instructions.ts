import {
  type ContextFragment,
  XmlRenderer,
  fragment,
} from '@deepagents/context';

/**
 * Instructions module - re-exports domain fragments from @deepagents/context.
 *
 * This module provides fragment builders for injecting domain knowledge
 * into AI prompts. All fragments are rendered using the context package renderers.
 */

// Re-export all domain and user fragments
export {
  // Domain fragments
  term,
  hint,
  guardrail,
  explain,
  example,
  clarification,
  workflow,
  quirk,
  styleGuide,
  analogy,
  glossary,
  // User fragments
  identity,
  persona,
  alias,
  preference,
  userContext,
  correction,
  // Core fragment utilities
  fragment,
  role,
  type ContextFragment,
} from '@deepagents/context';

/**
 * Render fragments to XML instructions.
 *
 * This is a convenience function that wraps fragments in a parent tag
 * and renders them using XmlRenderer with groupFragments enabled.
 *
 * @param tag - Parent tag name (e.g., 'instructions')
 * @param fragments - Fragments to render
 * @returns XML string
 *
 * @example
 * ```ts
 * const xml = toInstructions(
 *   'instructions',
 *   persona({ name: 'Freya', role: 'Data Assistant' }),
 *   guardrail({ rule: 'Never expose PII' }),
 *   hint('Always filter by status'),
 * );
 * ```
 */
export function toInstructions(
  tag: string,
  ...fragments: ContextFragment[]
): string {
  if (fragments.length === 0) {
    return '';
  }

  const renderer = new XmlRenderer({ groupFragments: true });
  const wrapped = fragment(tag, ...fragments);
  return renderer.render([wrapped]);
}
