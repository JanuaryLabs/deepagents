import * as SheetPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps } from 'react';

import { cn } from './index.ts';

function SheetContent({
  className,
  children,
  side,
  ...props
}: ComponentProps<typeof SheetPrimitive.Content> & {
  side: 'left' | 'right';
}) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 transition-opacity data-[state=closed]:opacity-0 data-[state=open]:opacity-100" />
      <SheetPrimitive.Content
        className={cn(
          'bg-background fixed inset-y-0 z-50 flex h-full flex-col shadow-lg transition-transform duration-200',
          side === 'left'
            ? 'left-0 border-r data-[state=closed]:-translate-x-full data-[state=open]:translate-x-0'
            : 'right-0 border-l data-[state=closed]:translate-x-full data-[state=open]:translate-x-0',
          className,
        )}
        {...props}
      >
        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export { SheetContent };
