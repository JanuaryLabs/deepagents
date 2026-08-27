import type { ElementType, ReactNode } from 'react';

import { cn } from '@deepagents/react-shadcn';

export type TextShimmerProps = {
  children: ReactNode;
  as?: ElementType;
  className?: string;
  /** Sweep duration in seconds; the shimmer utility defaults to 2s. */
  duration?: number;
  enabled?: boolean;
};

export function TextShimmer({
  children,
  as: Component = 'p',
  className,
  duration,
  enabled = true,
}: TextShimmerProps) {
  return (
    <Component
      className={cn(enabled && 'shimmer', className)}
      style={
        enabled && duration !== undefined
          ? { animationDuration: `${duration}s` }
          : undefined
      }
    >
      {children}
    </Component>
  );
}
