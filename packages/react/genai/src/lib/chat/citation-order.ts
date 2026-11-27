import type { UrlCitation } from './citations.ts';

/**
 * A text's citations in reading order, each at the offset it sits at: after
 * the words it supports, or at the end of the text when the provider gives no
 * offset (Anthropic sends none). `order` is the citation's index in its array.
 */
export function citationsInReadingOrder(
  text: string,
  citations: UrlCitation[],
) {
  return citations
    .map((citation, order) => ({
      citation,
      order,
      at: citation.endIndex ?? text.length,
    }))
    .sort((a, b) => a.at - b.at || a.order - b.order);
}
