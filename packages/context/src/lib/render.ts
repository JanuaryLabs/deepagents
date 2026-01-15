import { type ContextFragment, fragment } from './fragments.ts';
import { XmlRenderer } from './renderers/abstract.renderer.ts';

/**
 * Render fragments to XML.
 *
 * Wraps fragments in a parent tag and renders using XmlRenderer.
 *
 * @param tag - Parent tag name (e.g., 'instructions')
 * @param fragments - Fragments to render
 * @returns XML string
 *
 * @example
 * ```ts
 * const xml = render(
 *   'instructions',
 *   persona({ name: 'Freya', role: 'Data Assistant' }),
 *   guardrail({ rule: 'Never expose PII' }),
 * );
 * ```
 */
export function render(tag: string, ...fragments: ContextFragment[]): string {
  if (fragments.length === 0) {
    return '';
  }

  const renderer = new XmlRenderer();
  const wrapped = fragment(tag, ...fragments);
  return renderer.render([wrapped]);
}
