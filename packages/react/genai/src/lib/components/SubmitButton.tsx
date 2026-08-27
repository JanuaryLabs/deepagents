import {
  AnimatePresence,
  type HTMLMotionProps,
  motion,
  useReducedMotion,
} from 'motion/react';
import type { ReactNode } from 'react';

import { cn } from '@deepagents/react-shadcn';

import { ArrowUpIcon } from '../ui/ArrowUpIcon.tsx';

type SubmitButtonVariant = 'send' | 'stop';

type SubmitButtonProps = Omit<HTMLMotionProps<'button'>, 'children'> & {
  variant: SubmitButtonVariant;
};

const BUTTON_TRANSITION = { duration: 0.15, ease: [0, 0, 0.2, 1] } as const;
const ICON_TRANSITION = { duration: 0.12, ease: [0, 0, 0.2, 1] } as const;

export function SubmitButton({
  variant,
  className,
  disabled,
  ...rest
}: SubmitButtonProps) {
  const reducedMotion = useReducedMotion();
  const isStop = variant === 'stop';

  return (
    <motion.button
      initial={reducedMotion ? false : { opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reducedMotion ? undefined : { opacity: 0, scale: 0.9 }}
      transition={BUTTON_TRANSITION}
      whileHover={disabled || reducedMotion ? undefined : { scale: 1.04 }}
      whileTap={disabled || reducedMotion ? undefined : { scale: 0.96 }}
      aria-label={isStop ? 'Stop streaming' : 'Send prompt'}
      {...rest}
      disabled={disabled}
      className={cn(
        'relative flex size-8 items-center justify-center rounded-full',
        'bg-primary text-primary-foreground',
        'transition-opacity hover:opacity-90 active:opacity-80',
        'disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:opacity-35',
        'focus-visible:outline-[1.5px] focus-visible:outline-offset-[2.5px] focus-visible:outline-current',
        className,
      )}
    >
      <AnimatePresence initial={false}>
        <motion.span
          key={isStop ? 'stop' : 'send'}
          initial={reducedMotion ? false : { opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reducedMotion ? undefined : { opacity: 0, scale: 0.7 }}
          transition={ICON_TRANSITION}
          className="absolute flex items-center justify-center"
        >
          {isStop ? <ChatStopIcon /> : <ChatSendIcon />}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}

function ChatIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function ChatSendIcon() {
  return <ArrowUpIcon />;
}

function ChatStopIcon() {
  return (
    <ChatIcon>
      <rect x="5" y="5" width="10" height="10" rx="1.5" />
    </ChatIcon>
  );
}
