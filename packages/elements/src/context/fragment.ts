import dedent from 'dedent';

import type { ContextFragment } from '@deepagents/context';

import { toDescriptor } from '../lib/serialize.ts';
import type { ElementDescriptor } from '../lib/types.ts';

/**
 * Create a context fragment advertising the interactive-element catalog to
 * the model.
 *
 * Built from structured child fragments (like the skills fragment) rather
 * than a pre-formatted XML string: the XmlRenderer HTML-escapes string data,
 * so a pre-rendered blob would reach the model as `&lt;element&gt;` entities
 * instead of real tags.
 *
 * The descriptor snapshot rides on `metadata` for programmatic readback; it
 * is not rendered.
 *
 * @example
 * ```ts
 * context.set(elementsFragment([
 *   { name: 'followup', allowedAttributes: ['question'] },
 * ]));
 * ```
 */
export function elementsFragment(
  descriptors: ElementDescriptor[],
): ContextFragment {
  const snapshot = descriptors.map(toDescriptor);

  if (snapshot.length === 0) {
    return { name: 'elements', data: [], metadata: { elements: snapshot } };
  }

  const items: ContextFragment[] = snapshot.map((descriptor) => ({
    name: 'element',
    data: {
      name: descriptor.name,
      ...(descriptor.description
        ? { description: descriptor.description }
        : {}),
      'allowed-attributes': descriptor.allowedAttributes.join(', '),
    },
  }));

  return {
    name: 'elements',
    data: [
      { name: 'instructions', data: ELEMENTS_INSTRUCTIONS } as ContextFragment,
      ...items,
    ],
    metadata: { elements: snapshot },
  };
}

const ELEMENTS_INSTRUCTIONS = dedent`The UI elements listed below can be rendered inline in your response: write one as an HTML-style tag directly in your prose (e.g. \`<element-name attribute="value" />\`) and the client renders it as an interactive component.

### How to use elements
- Use an element only when the conversation matches its declared purpose.
- Only use element names from this list. Never invent elements.
- Only write attributes listed in that element's allowed-attributes. Never invent attributes.
- Keep the rest of your response as normal markdown; elements flow inline with the text.
`;
