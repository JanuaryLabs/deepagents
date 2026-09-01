import { type ElementDescriptor, findDuplicateName } from './types.ts';

export function toDescriptor<T extends ElementDescriptor>(
  element: T,
): ElementDescriptor {
  const { name, allowedAttributes, description } = element;
  return { name, allowedAttributes, description };
}

/**
 * Base-wins merging: an extra whose name collides with a base element is
 * dropped, so a platform's defaults cannot be hijacked by app extras.
 * Duplicate names WITHIN extras throw — silently keeping either copy would
 * make the prompt catalog and the render registry disagree.
 */
export function mergeElements<T extends ElementDescriptor>(
  base: T[],
  extras: T[] | undefined,
): T[] {
  if (!extras || extras.length === 0) return base;
  const duplicate = findDuplicateName(extras);
  if (duplicate !== undefined) {
    throw new Error(
      `Duplicate extra element <${duplicate}>: a catalog must map each tag to exactly one element.`,
    );
  }
  const baseNames = new Set(base.map((el) => el.name));
  const additions = extras.filter((el) => !baseNames.has(el.name));
  return [...base, ...additions];
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatElementsCatalog(elements: ElementDescriptor[]): string {
  if (elements.length === 0) return '';

  const items = elements
    .map((el) => {
      const description = el.description
        ? ` description="${escapeXmlAttribute(el.description)}"`
        : '';
      const attrs = el.allowedAttributes.map(escapeXmlAttribute).join(', ');
      return `<element name="${escapeXmlAttribute(el.name)}"${description}>\n  <allowed-attributes>${attrs}</allowed-attributes>\n</element>`;
    })
    .join('\n');

  return `<elements>
The following UI components are available to render inline in your response.
Use them only when the user's question matches their declared purpose. Never
invent attributes outside the listed allowedAttributes for each element.

${items}
</elements>`;
}
