import type { Citation, UIMessage } from 'ai';

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
 * Deduped by URL in first-seen order, so a source keeps one citation number
 * across every message of the chat.
 */
export function extractSourcesFromMessages(
  messages: UIMessage[],
): CitationSource[] {
  const seen = new Set<string>();
  const sources: CitationSource[] = [];
  const add = (url: string, title: string | undefined) => {
    if (seen.has(url)) return;
    seen.add(url);
    sources.push({ url, title });
  };
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'text')
        for (const { source } of urlCitationsOf(part.citations))
          add(source.url, source.title);
      if (part.type === 'source-url') add(part.url, part.title);
    }
  }
  return sources;
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
