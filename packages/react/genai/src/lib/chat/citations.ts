import type { Citation, TextUIPart, UIMessage } from 'ai';

import { citationsInReadingOrder } from './citation-order.ts';

export interface CitationSource {
  url: string;
  title?: string;
  /** The line under the title, such as a journal, a product or a site name. */
  description?: string;
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
 * Consecutive text parts as the one Markdown text they draw: a provider may
 * split a paragraph into several parts (@ai-sdk/anthropic gives each cited
 * span its own). Each citation's offsets move by the length joined before its
 * part, and a citation with no offset covers its own part, so it still sits
 * at that part's end.
 */
export function joinTextParts(parts: readonly TextUIPart[]): {
  text: string;
  citations: Citation[];
} {
  let text = '';
  const citations: Citation[] = [];
  for (const part of parts) {
    const at = text.length;
    for (const citation of part.citations ?? [])
      citations.push({
        ...citation,
        startIndex: at + (citation.startIndex ?? 0),
        endIndex: at + (citation.endIndex ?? part.text.length),
      });
    text += part.text;
  }
  return { text, citations };
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
