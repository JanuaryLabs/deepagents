import type { Ref, TextareaHTMLAttributes } from 'react';

import { cn } from '@deepagents/react-shadcn';

type ChatTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: Ref<HTMLTextAreaElement>;
};

export function ChatTextarea({ className, ref, ...props }: ChatTextareaProps) {
  return (
    <div className="relative w-full">
      <textarea
        className={cn(
          'border-input bg-background flex w-full rounded-md border px-3 py-2 text-sm',
          'transition-all duration-200 ease-in-out',
          'placeholder:text-muted-foreground',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        ref={ref}
        {...props}
      />
    </div>
  );
}
