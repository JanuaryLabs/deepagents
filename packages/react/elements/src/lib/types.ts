import type { ComponentType } from 'react';

export type ToolTip = {
  text: string;
  cooldown: 'frequent' | 'moderate' | 'rare';
  visibility?: 'always' | 'before-interaction' | 'after-interaction';
};

export interface GenAIInteractiveElement {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- allowedAttributes defines the runtime prop interface for each registered element
  component: ComponentType<any>;
  /**
   * HTML attributes the model may write on this element. Must not contain
   * {@link RESERVED_ELEMENT_ATTRIBUTES}: the markdown sanitizer rewrites
   * those to `user-content-<value>` (DOM-clobbering protection), so the
   * component would silently receive a mangled value. Use a domain attribute
   * instead — e.g. `param`, not `name`.
   */
  allowedAttributes: string[];
  description?: string;
  tips?: ToolTip[];
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

export function assertNoReservedAttributes(
  element: Pick<GenAIInteractiveElement, 'name' | 'allowedAttributes'>,
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

export type ElementDescriptor = Pick<
  GenAIInteractiveElement,
  'name' | 'allowedAttributes' | 'description'
>;
