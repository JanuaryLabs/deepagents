import type { HTMLMotionProps } from 'motion/react';
import { motion } from 'motion/react';
import * as React from 'react';

import { cn } from '@deepagents/react-shadcn';

interface AgentActionButtonProps extends Omit<
  HTMLMotionProps<'button'>,
  'children'
> {
  icon: React.ReactNode;
}

export function ChatActionButton({
  icon,
  className,
  ...props
}: AgentActionButtonProps) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.94 }}
      className={cn(
        'group text-muted-foreground hover:text-foreground relative rounded-lg p-2 transition-colors',
        className,
      )}
      {...props}
    >
      {icon}
      <span className="bg-primary/10 absolute inset-0 rounded-lg opacity-0 transition-opacity group-hover:opacity-100" />
    </motion.button>
  );
}
