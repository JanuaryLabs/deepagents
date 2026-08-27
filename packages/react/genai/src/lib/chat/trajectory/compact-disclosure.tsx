import { ChevronRight } from 'lucide-react';

import { cn } from '@deepagents/react-shadcn';

export function CompactDisclosureChevron({
  className,
}: {
  className?: string;
}) {
  return (
    <ChevronRight
      aria-hidden
      className={cn(
        'size-3.5 shrink-0 transition-transform group-data-[panel-open]:rotate-90',
        className,
      )}
    />
  );
}

export function compactDisclosureTriggerClass(extra?: string) {
  return cn(
    'group hover:bg-muted/30 flex min-h-7 w-full gap-2 rounded-sm py-1 text-left transition-colors',
    extra,
  );
}
