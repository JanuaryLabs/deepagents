/**
 * The platform-neutral, serializable description of one interactive element:
 * the vocabulary a model may write as inline HTML-style tags. Rendering
 * concerns (e.g. a React component) belong to host adapters that extend this
 * shape — never to this package.
 */
export interface ElementDescriptor {
  name: string;
  /**
   * HTML attributes the model may write on this element. Must not contain
   * {@link RESERVED_ELEMENT_ATTRIBUTES}: the markdown sanitizer rewrites
   * those to `user-content-<value>` (DOM-clobbering protection), so the
   * component would silently receive a mangled value. Use a domain attribute
   * instead — e.g. `param`, not `name`.
   */
  allowedAttributes: string[];
  description?: string;
}

/**
 * Attributes the markdown sanitizer clobber-prefixes with `user-content-`
 * before props reach the component. Interactive elements must not declare
 * them; {@link assertNoReservedAttributes} enforces this at registration.
 */
export const RESERVED_ELEMENT_ATTRIBUTES = new Set([
  'name',
  'id',
  'aria-describedby',
  'aria-labelledby',
]);

export function findDuplicateName(
  elements: Iterable<Pick<ElementDescriptor, 'name'>>,
): string | undefined {
  const seen = new Set<string>();
  for (const { name } of elements) {
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return undefined;
}

export function assertNoReservedAttributes(
  element: Pick<ElementDescriptor, 'name' | 'allowedAttributes'>,
): void {
  const reserved = element.allowedAttributes.filter((attribute) =>
    RESERVED_ELEMENT_ATTRIBUTES.has(attribute),
  );
  if (reserved.length > 0) {
    throw new Error(
      `Interactive element <${element.name}> declares reserved attribute(s) ${reserved.join(', ')}. ` +
        `The markdown sanitizer rewrites these to "user-content-<value>" (DOM-clobbering protection), ` +
        `so the component would receive a mangled value. Use a domain attribute instead (e.g. "param").`,
    );
  }
}
