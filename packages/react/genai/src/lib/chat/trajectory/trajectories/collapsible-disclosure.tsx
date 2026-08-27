import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
} from '@deepagents/react-shadcn';

export function CollapsibleDisclosure({
  label,
  open,
  onOpenChange,
  children,
  className,
  triggerClassName,
  contentClassName,
  chevronClassName,
}: {
  label: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  chevronClassName?: string;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className={className}>
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className={cn('flex items-center font-mono', triggerClassName)}
          />
        }
      >
        <ChevronDown
          className={cn(
            'size-4 transition-transform',
            chevronClassName,
            open && 'rotate-180',
          )}
        />
        <span>{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className={contentClassName}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
