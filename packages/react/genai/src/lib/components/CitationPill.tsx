import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@zukhruf/shadcn';
import type { ReactNode } from 'react';

import type { CitationSource } from '../chat/citations.ts';

// The detail opens from a Popover button on hover, tap and keyboard: a title
// attribute reaches only mouse users, and Base UI's hover card is not touch or
// keyboard navigable.
export function CitationPill({
  source,
  index,
  labels = { source: `Source ${index}`, open: 'Open the source' },
  children,
}: {
  source: CitationSource;
  index: number;
  /** The pill's own words, in the host's language. */
  labels?: { source: string; open: string };
  /** The host's own detail for this source, such as notices or attribution. */
  children?: ReactNode;
}) {
  // A source-url's url is provider data typed only as string, and new URL()
  // would throw on a malformed one and take the whole message down.
  const site = URL.parse(source.url)?.hostname ?? source.url;
  return (
    <sup className="ml-0.5 inline-block">
      <Popover>
        <PopoverTrigger
          openOnHover
          aria-label={labels.source}
          className="text-primary bg-primary/10 hover:bg-primary/20 focus-visible:ring-ring focus-visible:ring-offset-background inline-block rounded px-1 font-mono text-[10px] leading-tight transition-colors focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none"
        >
          {index}
        </PopoverTrigger>
        <PopoverContent className="w-72 gap-2 text-sm">
          {/* One truncated line, not line-clamp (it can leave a line mostly
              empty); the title attribute keeps the full text. */}
          <PopoverHeader>
            <PopoverTitle
              dir="auto"
              title={source.title ?? site}
              className="truncate"
            >
              {source.title ?? site}
            </PopoverTitle>
            {source.title ? (
              <PopoverDescription dir="auto" title={site} className="truncate">
                {site}
              </PopoverDescription>
            ) : null}
          </PopoverHeader>
          {children}
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline"
          >
            {labels.open}
          </a>
        </PopoverContent>
      </Popover>
    </sup>
  );
}
