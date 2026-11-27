import { cn } from 'cn';
import type { ElementType, ReactNode } from 'react';

export type TextShimmerProps = {
  children: ReactNode;
  as?: ElementType;
  className?: string;
  /** The text's direction; `auto` for text in the host's language. */
  dir?: 'auto' | 'ltr' | 'rtl';
  /** Sweep duration in seconds; the shimmer utility defaults to 2s. */
  duration?: number;
  enabled?: boolean;
};

export function TextShimmer({
  children,
  as: Component = 'p',
  className,
  dir,
  duration,
  enabled = true,
}: TextShimmerProps) {
  return (
    <Component
      dir={dir}
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
