import dedent from 'dedent';

import { type ContextFragment, verbatim } from '@deepagents/context';

import { toDescriptor } from '../lib/serialize.ts';
import type { ElementDescriptor } from '../lib/types.ts';

/**
 * Create a context fragment advertising the interactive-element catalog to
 * the model.
 *
 * Renders an `<elements>` block as written, in every renderer. It goes
 * through `verbatim()` because the instructions show the tag syntax itself (`<element-name … />`): an
 * escaping renderer would show the model `&lt;element-name … /&gt;`, and a
 * model that copies the example then writes escaped tags no client draws.
 * Descriptions reach the model as the host wrote them, so a tag inside one
 * stays a tag. Like every verbatim fragment it renders only at the top level
 * of a context. With no descriptors it renders nothing.
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

  const elements = snapshot.map((descriptor) =>
    [
      '  <element>',
      `    <name>${descriptor.name}</name>`,
      ...(descriptor.description
        ? [`    <description>${descriptor.description}</description>`]
        : []),
      `    <allowed-attributes>${descriptor.allowedAttributes.join(', ')}</allowed-attributes>`,
      '  </element>',
    ].join('\n'),
  );

  return {
    ...verbatim(
      [
        '<elements>',
        '  <instructions>',
        ELEMENTS_INSTRUCTIONS.split('\n')
          .map((line) => (line ? `    ${line}` : line))
          .join('\n'),
        '  </instructions>',
        ...elements,
        '</elements>',
      ].join('\n'),
    ),
    metadata: { elements: snapshot },
  };
}

const ELEMENTS_INSTRUCTIONS = dedent`The UI elements listed below can be rendered inline in your response: write one as an HTML-style tag directly in your prose (e.g. \`<element-name attribute="value" />\`) and the client renders it as an interactive component.

### How to use elements
- Use an element only when the conversation matches its declared purpose.
- Only use element names from this list. Never invent elements.
- Only write attributes listed in that element's allowed-attributes. Never invent attributes.
- Keep the rest of your response as normal markdown; elements flow inline with the text.`;
