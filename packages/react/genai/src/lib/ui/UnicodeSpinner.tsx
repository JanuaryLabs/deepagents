import { useEffect, useState } from 'react';

import { cn } from '@deepagents/react-shadcn';

const spinners = {
  braille: {
    frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    interval: 80,
  },
  pulse: {
    frames: [
      '⠁',
      '⠉',
      '⠋',
      '⠛',
      '⠟',
      '⠿',
      '⡿',
      '⣿',
      '⡿',
      '⠿',
      '⠟',
      '⠛',
      '⠋',
      '⠉',
      '⠁',
      '⠀',
    ],
    interval: 80,
  },
  clock: {
    frames: ['⠁', '⠈', '⠐', '⠠', '⢀', '⡀', '⠄', '⠂'],
    interval: 100,
  },
  limerence: {
    frames: ['⠁', '⠃', '⠇', '⡇', '⣇', '⣇', '⣆', '⣄', '⣀', '⢀', '⠀'],
    interval: 100,
  },
} as const;

type SpinnerVariant = keyof typeof spinners;

function UnicodeSpinner({
  className,
  variant = 'braille',
  ...props
}: Omit<React.ComponentProps<'span'>, 'children'> & {
  variant?: SpinnerVariant;
}) {
  const { frames, interval } = spinners[variant];
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) return;

    const timer = setInterval(() => {
      setFrameIndex((i) => (i + 1) % frames.length);
    }, interval);
    return () => clearInterval(timer);
  }, [frames.length, interval]);

  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn('inline-block', className)}
      {...props}
    >
      {frames[frameIndex]}
    </span>
  );
}

export { UnicodeSpinner };
export type { SpinnerVariant };
