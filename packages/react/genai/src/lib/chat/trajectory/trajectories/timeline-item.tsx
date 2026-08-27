import type { ReactNode } from 'react';

import { cn } from '@deepagents/react-shadcn';

export function TimelineItem({
  marker,
  children,
  className,
}: {
  marker: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('relative z-0 flex gap-3 pl-5', className)}>
      {marker}
      {children}
    </div>
  );
}
