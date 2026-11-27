import type { Citation, UIMessage } from 'ai';

import { citationsInReadingOrder } from './citation-order.ts';

export interface CitationSource {
  url: string;
  title?: string;
}

/** A citation of a web page, the only kind react-genai draws. */
export type UrlCitation = Citation & {
  source: Extract<Citation['source'], { sourceType: 'url' }>;
};

export function urlCitationsOf(
  citations: Citation[] | undefined,
): UrlCitation[] {
  return (citations ?? []).filter(
    (citation): citation is UrlCitation => citation.source.sourceType === 'url',
  );
}

/**
 * An answer's sources, deduped by URL and numbered per answer in the order the
 * answer shows them: a text's citations where they sit, and a source-url part
 * where it stands, unless a text citation of the answer draws it inline.
 */
export function extractSourcesFromMessage(
  message: UIMessage,
): CitationSource[] {
  // Copy of buildMessageTrajectorySegments' citedInline (strike 2, #6040).
  const citedInline = new Set(
    message.parts.flatMap((part) =>
      part.type === 'text'
        ? urlCitationsOf(part.citations).map(({ source }) => source.url)
        : [],
    ),
  );
  const sources = new Map<string, CitationSource>();
  const add = (url: string, title: string | undefined) => {
    if (!sources.has(url)) sources.set(url, { url, title });
  };
  for (const part of message.parts) {
    if (part.type === 'text')
      for (const { citation } of citationsInReadingOrder(
        part.text,
        urlCitationsOf(part.citations),
      ))
        add(citation.source.url, citation.source.title);
    if (part.type === 'source-url' && !citedInline.has(part.url))
      add(part.url, part.title);
  }
  return [...sources.values()];
}

/**
 * The 1-based citation number of `url` in `sources`, or null when `sources`
 * does not hold it.
 */
export function citationIndexOf(
  sources: CitationSource[],
  url: string,
): number | null {
  const i = sources.findIndex((s) => s.url === url);
  return i === -1 ? null : i + 1;
}
