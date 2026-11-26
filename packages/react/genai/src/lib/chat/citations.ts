import type { UIMessage } from 'ai';

export interface CitationSource {
  url: string;
  title?: string;
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
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== 'source-url') continue;
      if (seen.has(part.url)) continue;
      seen.add(part.url);
      sources.push({ url: part.url, title: part.title });
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
