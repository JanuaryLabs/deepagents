import type { ElementDescriptor, GenAIInteractiveElement } from './types.ts';

export function toDescriptor(
  element: GenAIInteractiveElement,
): ElementDescriptor {
  const { name, allowedAttributes, description } = element;
  return { name, allowedAttributes, description };
}

export function mergeElements(
  base: GenAIInteractiveElement[],
  extras: GenAIInteractiveElement[] | undefined,
): GenAIInteractiveElement[] {
  if (!extras || extras.length === 0) return base;
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
