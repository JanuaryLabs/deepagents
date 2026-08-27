import type { UIMessage } from 'ai';

export interface CitationSource {
  url: string;
  title?: string;
}

/**
 * Flatten all `source-url` parts across the given messages, deduped by URL,
 * preserving first-seen order. Used by both the inline CitationPill renderer
 * and the WorkspaceBody Sources panel so their numbering stays in sync.
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
 * Look up the 1-based citation index for a given URL within a deduped source
 * list. Returns null when the URL is not present (defensive — shouldn't happen
 * in practice when the same `extractSourcesFromMessages` output is used).
 */
export function citationIndexOf(
  sources: CitationSource[],
  url: string,
): number | null {
  const i = sources.findIndex((s) => s.url === url);
  return i === -1 ? null : i + 1;
}
