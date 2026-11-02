import { useMemo } from 'react';
import type { Components } from 'streamdown';

import { assertNoReservedAttributes } from '@deepagents/elements';

import { MarkdownParagraph } from '../chat/markdown-paragraph.tsx';
import { Response, type ResponseProps } from '../elements/Response.tsx';
import type { GenAIInteractiveElement } from '../elements/interactive-element.ts';

export type { GenAIInteractiveElement };

type InteractiveResponseProps = Omit<
  ResponseProps,
  'components' | 'allowedTags'
> & {
  elements?: GenAIInteractiveElement[];
};

// Streamdown's Components types every entry, `p` included, as taking untyped
// props, so only an inline component gets `children` typed from the context.
const markdownComponents: Components = {
  p: ({ children }) => <MarkdownParagraph>{children}</MarkdownParagraph>,
};

function buildStreamdownRegistry(entries: GenAIInteractiveElement[]) {
  const components: Components = { ...markdownComponents };
  const allowedTags: Record<string, string[]> = {};
  for (const entry of entries) {
    assertNoReservedAttributes(entry);
    components[entry.name] = entry.component;
    allowedTags[entry.name] = entry.allowedAttributes;
  }
  return { components, allowedTags };
}

export function InteractiveResponse({
  elements,
  ...props
}: InteractiveResponseProps) {
  const registry = useMemo(
    () => buildStreamdownRegistry(elements ?? []),
    [elements],
  );
  return <Response {...registry} {...props} />;
}
