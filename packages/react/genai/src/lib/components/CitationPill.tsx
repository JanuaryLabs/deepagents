import type { CitationSource } from '../chat/citations.ts';

export function CitationPill({
  source,
  index,
}: {
  source: CitationSource;
  index: number;
}) {
  return (
    <sup className="ml-0.5 inline-block">
      <a
        href={source.url}
        target="_blank"
        rel="noopener noreferrer"
        title={source.title ?? source.url}
        className="text-primary bg-primary/10 hover:bg-primary/20 focus-visible:ring-ring focus-visible:ring-offset-background inline-block rounded px-1 font-mono text-[10px] leading-tight no-underline transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none"
      >
        {index}
      </a>
    </sup>
  );
}
